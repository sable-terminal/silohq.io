-- 030_ontology — what the customer's data MEANS, derived from their systems.
--
-- ── Nothing is predefined ───────────────────────────────────────────────────
--
-- §2.1: NO CONCEPTS SHIP WITH THE PRODUCT. There is no seed in this file and
-- there must never be one. A predefined concept is a guess about what a customer
-- means by "customer"; a derived one comes from their own database, which
-- already contains a decade of domain modelling nobody has to redo.
--
-- The consequence is structural: every row in `concepts` is owned by an
-- organisation and created by a person confirming a proposal. Two customers with
-- a concept called "customer" have unrelated concepts, and nothing in this
-- schema lets one see the other's.
--
-- ── Confirmation is what creates a concept ──────────────────────────────────
--
-- §2.4. A proposal is not a concept. Derivation fills the form in; a person
-- presses the button. `concepts.confirmed_by` is NOT NULL for that reason —
-- there is no such thing as a concept nobody agreed to.

CREATE TABLE concepts (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /*
   * WHERE IT CAME FROM, KEPT. Whether somebody accepted a proposal as offered,
   * renamed it, or built it by hand is the difference between "derivation is
   * working" and "derivation is being corrected every time", and that is only
   * answerable if it is recorded at the moment.
   */
  proposal_id     uuid,
  origin          text        NOT NULL DEFAULT 'confirmed'
                                CHECK (origin IN ('confirmed', 'corrected', 'manual')),

  /* §2.4: confirmation is the creating act, so there is no unconfirmed row. */
  confirmed_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),

  /*
   * §2.5 SAYS A CONCEPT HOLDS MARKINGS AND THERE IS NO COLUMN HERE FOR THEM,
   * because the auth layer already owns that: `resource_markings`, keyed on
   * ('concept', id), is what `authorisation.service` reads to decide whether a
   * concept may be resolved at all. A second home for the same fact is a second
   * answer waiting to disagree with the first — and the one the compiler reads
   * is the one that matters.
   *
   * (004 also created `concept_markings`, which nothing has ever read. It is
   * superseded by `resource_markings` and wants dropping.)
   */

  retired_at      timestamptz,

  /*
   * ONE NAME PER ORGANISATION, among the live ones. Two concepts called
   * "customer" in one tenant is not a richer ontology, it is a resolution bug
   * waiting to be blamed on the resolver.
   */
  CONSTRAINT concepts_name_unique UNIQUE (organisation_id, name)
);

CREATE INDEX concepts_by_org ON concepts (organisation_id) WHERE retired_at IS NULL;

/*
 * ── What contributes to a concept ──────────────────────────────────────────
 *
 * §2.5: one contributing object per connector, each with its own identifier
 * field and its own match keys. This is the table the resolver reads, and it is
 * the whole reason a disagreement detector can say "the same invoice" rather
 * than "two rows that look alike".
 *
 * MATCH STRATEGY IS A COLUMN WITH ONE LEGAL VALUE, and that is deliberate.
 * §2.6 says exact, never fuzzy, anywhere in the data path — a wrong merge
 * silently corrupts every answer after it, which is worse than failing to
 * merge. The column exists so the guarantee is visible in the schema rather
 * than remembered in a service; the CHECK is what stops a future `fuzzy` being
 * added without somebody deleting this comment first.
 */
CREATE TABLE concept_objects (
  id              uuid        PRIMARY KEY,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,

  /** The object in that connection's manifest, by name. */
  object_name     text        NOT NULL CHECK (length(trim(object_name)) BETWEEN 1 AND 128),

  /*
   * WHICH FIELD IS THE INSTANCE. Not a value — a field path, so an entity is
   * referred to by identifier and never by its contents. Findings carry
   * `entity_ref` on the same principle.
   */
  identifier_field text       NOT NULL CHECK (length(trim(identifier_field)) BETWEEN 1 AND 256),

  /*
   * THE FIELDS RESOLUTION RUNS AGAINST, in order. Ordered because the first
   * that matches decides, and a set would leave that to whatever the planner
   * felt like.
   */
  match_keys      text[]      NOT NULL CHECK (cardinality(match_keys) > 0),

  match_strategy  text        NOT NULL DEFAULT 'exact' CHECK (match_strategy = 'exact'),

  added_by        uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  added_at        timestamptz NOT NULL DEFAULT now(),

  /*
   * ONE OBJECT PER CONNECTION PER CONCEPT. §2.5 says one contributing object per
   * connector; two would mean "invoice" was both `invoices` and `credit_notes`
   * in the same system, which is two concepts wearing one name.
   */
  CONSTRAINT concept_objects_one_per_connection UNIQUE (concept_id, connection_id)
);

CREATE INDEX concept_objects_by_concept ON concept_objects (concept_id);
CREATE INDEX concept_objects_by_connection ON concept_objects (connection_id);

/*
 * ── Proposals ──────────────────────────────────────────────────────────────
 *
 * §2.2 and §2.4: derivation proposes, a person confirms. A proposal carries its
 * own evidence so the confirmation screen can say WHY it thinks these two
 * objects are the same thing — field overlap, value overlap, a foreign key —
 * rather than presenting a confidence number and asking for trust.
 *
 * EVIDENCE IS STRUCTURE, NOT VALUES. Field names, counts, overlap ratios. The
 * same line 019 draws for discovery: there is no column here for a value read
 * out of the customer's data, and there must never be one.
 */
CREATE TABLE concept_proposals (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  proposed_name   text        NOT NULL CHECK (length(trim(proposed_name)) BETWEEN 1 AND 128),

  /*
   * [{ connectionId, objectName, identifierField, matchKeys[] }]. Filled in, so
   * §2.4's "proposals arrive filled in" is true of the payload and not only of
   * the screen.
   */
  contributing    jsonb       NOT NULL DEFAULT '[]',
  evidence        jsonb       NOT NULL DEFAULT '{}',
  confidence      numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),

  decision        text        CHECK (decision IS NULL OR decision IN ('confirmed', 'corrected', 'rejected')),
  reviewed_by     uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  reviewed_at     timestamptz,
  concept_id      uuid        REFERENCES concepts(id) ON DELETE SET NULL,

  proposed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT concept_proposals_reviewed_pair CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
  /* A concept is the consequence of agreeing, so it cannot precede one. */
  CONSTRAINT concept_proposals_concept_needs_yes CHECK (
    concept_id IS NULL OR decision IN ('confirmed', 'corrected')
  )
);

CREATE INDEX concept_proposals_open ON concept_proposals (organisation_id) WHERE reviewed_at IS NULL;

/*
 * ── Unresolved pairs ───────────────────────────────────────────────────────
 *
 * §2.6. Where the resolver cannot match, it does not approximate — it says so,
 * and the model is asked whether the two are the same entity. The answer is a
 * PROPOSAL. On confirmation the pair becomes an exact mapping and resolution is
 * deterministic thereafter.
 *
 * `Acme Group Ltd` and `ACME GROUP LIMITED` are resolved once, by a person, and
 * never inferred again. That is what keeps inference out of the data path
 * entirely: the model suggests, a human decides, the result is arithmetic.
 *
 * REFS, NOT VALUES. `value_ref_a` is how the source identifies the row, not
 * what the row says. The no-data-stored line holds here as everywhere.
 */
CREATE TABLE unresolved_pairs (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  connection_a    uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  value_ref_a     text        NOT NULL CHECK (length(trim(value_ref_a)) BETWEEN 1 AND 512),
  connection_b    uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  value_ref_b     text        NOT NULL CHECK (length(trim(value_ref_b)) BETWEEN 1 AND 512),

  proposed_by     text        NOT NULL CHECK (proposed_by IN ('resolver', 'model')),
  model_rationale text,

  confirmed_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz,
  rejected_at     timestamptz,

  proposed_at     timestamptz NOT NULL DEFAULT now(),

  /* Decided one way or the other, never both. */
  CONSTRAINT unresolved_pairs_one_decision CHECK (confirmed_at IS NULL OR rejected_at IS NULL),
  CONSTRAINT unresolved_pairs_confirmed_pair CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CONSTRAINT unresolved_pairs_unique UNIQUE (concept_id, connection_a, value_ref_a, connection_b, value_ref_b)
);

/* The resolver reads only the confirmed ones, and reads them on every query. */
CREATE INDEX unresolved_pairs_confirmed
  ON unresolved_pairs (concept_id, connection_a, value_ref_a)
  WHERE confirmed_at IS NOT NULL;

CREATE INDEX unresolved_pairs_open
  ON unresolved_pairs (organisation_id)
  WHERE confirmed_at IS NULL AND rejected_at IS NULL;

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE concepts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts           FORCE  ROW LEVEL SECURITY;
ALTER TABLE concept_objects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_objects    FORCE  ROW LEVEL SECURITY;
ALTER TABLE concept_proposals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_proposals  FORCE  ROW LEVEL SECURITY;
ALTER TABLE unresolved_pairs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE unresolved_pairs   FORCE  ROW LEVEL SECURITY;

CREATE POLICY concepts_tenant ON concepts
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

/*
 * `organisation_id` IS DENORMALISED ONTO THE CHILD ON PURPOSE. The policy could
 * join to `concepts` instead, and then every read of a contributing object
 * would carry a subquery that RLS re-evaluates per row. The column is the same
 * fact, written twice, checked cheaply.
 */
CREATE POLICY concept_objects_tenant ON concept_objects
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY concept_proposals_tenant ON concept_proposals
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY unresolved_pairs_tenant ON unresolved_pairs
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON concepts          TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON concept_objects   TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON concept_proposals TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON unresolved_pairs  TO silo_app;
