-- 033_associations — things that move together, and the outcomes worth caring
-- about.
--
-- ── The column that is not here ─────────────────────────────────────────────
--
-- §4.2: CAUSATION IS NEVER ASSERTED. There is no `causes`, no `cause_id`, no
-- `direction_of_effect` in this file and there must never be one. Confounding
-- cannot be ruled out from observational data without stated domain
-- assumptions, and stating those is exactly the modelling engagement §1 refuses
-- to be.
--
-- The output language is fixed by what this schema can express: *these move
-- together, 78 of 94 times, in this order*. A schema that cannot hold a causal
-- claim cannot leak one through a feature nobody reviewed — the same mechanism
-- 019 uses to guarantee discovery stores no rows.
--
-- This is the stronger position with a technical audience, not the weaker one.
-- The causal claim gets dismantled the moment somebody asks what was controlled
-- for; "they co-occur, here is n" survives the question.
--
-- ── Conditions, not individual findings ────────────────────────────────────
--
-- §8 names the columns "finding A, finding B" and §4.1 says "between two
-- findings OR conditions". Both sides here are a CONDITION — a detector's
-- verdict on one measure of one concept — and not a finding id, because a
-- finding is about one entity and a pair of them has a sample size of one.
--
-- "These move together, 78 of 94 times" is a statement about two conditions
-- over 94 entities. Pointing it at two rows would make the sentence
-- unutterable, and §4.1 requires the sample size be stated ALWAYS.

CREATE TABLE associations (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * Each side: which detector, on which concept, about which measure. The same
   * triple `findings` is keyed on, which is what lets an association be turned
   * back into the findings behind it without storing them here.
   */
  detector_a      text        NOT NULL,
  concept_a       uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  measure_a       text        NOT NULL CHECK (length(trim(measure_a)) BETWEEN 1 AND 256),

  detector_b      text        NOT NULL,
  concept_b       uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  measure_b       text        NOT NULL CHECK (length(trim(measure_b)) BETWEEN 1 AND 256),

  /*
   * ONE ROW PER UNORDERED PAIR, ENFORCED BY ORDERING IT. Co-occurrence is
   * symmetric, so (A,B) and (B,A) are the same fact; storing both would let two
   * rows disagree after a recompute, and the reader would have no way to tell
   * which was current. Row comparison puts the pair in a canonical order and the
   * unique constraint then means what it looks like it means.
   */
  CONSTRAINT associations_canonical_order CHECK (
    (detector_a, concept_a, measure_a) < (detector_b, concept_b, measure_b)
  ),
  CONSTRAINT associations_unique UNIQUE (
    organisation_id, detector_a, concept_a, measure_a, detector_b, concept_b, measure_b
  ),

  /*
   * §4.1 — SAMPLE SIZE, STATED ALWAYS. NOT NULL, and the co-occurrence count
   * cannot exceed it. A strength with no denominator is the thing every
   * correlation screenshot on the internet is, and the constraint is cheaper
   * than the discipline.
   */
  co_occurrence   integer     NOT NULL CHECK (co_occurrence >= 0),
  sample_size     integer     NOT NULL CHECK (sample_size > 0),
  CONSTRAINT associations_within_sample CHECK (co_occurrence <= sample_size),

  /*
   * Observed co-occurrence over what independence would predict. One means
   * "exactly as often as chance"; three means "three times as often as two
   * unrelated conditions would manage".
   *
   * IT IS HERE BECAUSE THE RATIO ALONE MISLEADS. Two conditions that each hold
   * on nearly every entity co-occur constantly and mean nothing, and a strength
   * figure cannot tell that apart from a real pattern.
   */
  lift            numeric(8,3) NOT NULL CHECK (lift >= 0),

  /** Shared entities over entities showing either. Symmetric, like the pair. */
  strength        numeric(4,3) NOT NULL CHECK (strength BETWEEN 0 AND 1),

  /*
   * §4.1 — TEMPORAL ORDERING, WHERE TIMESTAMPS PERMIT, and `unknown` is the
   * honest default rather than a gap.
   *
   * IT IS NEVER COMPUTED FROM `findings.detected_at`. That column records when
   * a detector ran, so ordering by it would report the order the engine
   * happened to execute in as a fact about the customer's business — an
   * artefact that would look exactly like a discovery.
   */
  temporal_order  text        NOT NULL DEFAULT 'unknown'
                                CHECK (temporal_order IN ('a_first', 'b_first', 'concurrent', 'unknown')),

  /*
   * §4.1 — STRUCTURAL DIRECTION, where foreign keys or dependency edges
   * constrain which way a relationship COULD run. This is the weakest possible
   * directional claim and the only defensible one: a line item cannot precede
   * its order in the schema, whatever the data says, and that is a fact about
   * the model rather than about cause.
   */
  structural_direction text   NOT NULL DEFAULT 'unknown'
                                CHECK (structural_direction IN ('a_to_b', 'b_to_a', 'none', 'unknown')),

  computed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX associations_by_strength ON associations (organisation_id, lift DESC, strength DESC);
CREATE INDEX associations_by_concept ON associations (organisation_id, concept_a, concept_b);

/*
 * ── Outcome designations ───────────────────────────────────────────────────
 *
 * §4.3. The customer names the fields that represent an outcome that matters:
 * late delivery, cost overrun, complaint, churn, missed deadline.
 *
 * A ONE-TIME INPUT, NOT A MODELLING ENGAGEMENT, and the size of this table is
 * the argument. Four columns and a direction — not a target variable, not a
 * feature set, not a training run. Once designated, every finding ranks against
 * it automatically and the ranking is DATA-DERIVED rather than assumed, which is
 * the whole difference between this and a consultancy project.
 *
 * A FIELD PATH, NEVER A VALUE. The same line §2.5 and §3.2 draw: the customer
 * says WHICH FIELD means late, not what late is. A threshold typed in here would
 * be a domain assumption, and §1 says none ship.
 */
CREATE TABLE outcome_designations (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  field_path      text        NOT NULL CHECK (length(trim(field_path)) BETWEEN 1 AND 256),

  /*
   * WHICH WAY IS BAD, because nothing else can know. Days late: higher is worse.
   * Margin: lower is worse. There is no third answer and no default — a
   * designation whose direction somebody did not state is a designation that
   * cannot rank anything, so the column is NOT NULL with no default.
   */
  direction       text        NOT NULL CHECK (direction IN ('higher_is_worse', 'lower_is_worse')),

  /** What this means to the people who work here, in their words. */
  label           text        CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 128),

  designated_by   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  designated_at   timestamptz NOT NULL DEFAULT now(),

  retired_at      timestamptz,

  /* One live answer per field. Two directions on one field is a contradiction,
     not a richer configuration. */
  CONSTRAINT outcome_designations_unique UNIQUE (organisation_id, concept_id, field_path)
);

CREATE INDEX outcome_designations_live
  ON outcome_designations (organisation_id) WHERE retired_at IS NULL;

/*
 * DESIGNATING AN OUTCOME IS AN ORGANISATION-WIDE STATEMENT, which is why this
 * is not `scopeable`. "Late delivery is what we care about" is a claim about the
 * business, and every ranking anybody sees afterwards is ordered by it — a
 * subtree admin making it for the whole organisation is the wrong blast radius,
 * unlike `concept.confirm`, which is bounded by the connections they can reach.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('outcome.designate', 'ontology', 'Declare which fields represent an outcome that matters', false);

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE associations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE associations          FORCE  ROW LEVEL SECURITY;
ALTER TABLE outcome_designations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_designations  FORCE  ROW LEVEL SECURITY;

CREATE POLICY associations_tenant ON associations
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY outcome_designations_tenant ON outcome_designations
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON associations         TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON outcome_designations TO silo_app;
