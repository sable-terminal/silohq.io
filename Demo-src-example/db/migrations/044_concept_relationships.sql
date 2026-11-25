-- 044_concept_relationships — the link association was inferring instead of reading.
--
-- ── What was wrong ──────────────────────────────────────────────────────────
--
-- §4.1 asks association analysis for structural direction: which way a
-- relationship COULD run, constrained by foreign keys. Nothing carried a
-- foreign key that far. `discovery.relationships` is in the connector manifest,
-- `concept_objects` did not carry it forward, and association was left relating
-- two concepts by whether their findings happened to share an entity reference.
--
-- That produced fabricated findings: `INV-001` under `invoice` and `INV-001`
-- under `purchase order` looked like one entity, so two unrelated concepts
-- co-occurred perfectly whenever a customer's systems numbered things the same
-- way — which is most of the time. Association now refuses cross-concept pairs
-- and counts them, which is honest and useless.
--
-- This is the missing link. A relationship declared here lets association walk
-- concept A to concept B through something the customer's own schema states,
-- rather than inferring one from what findings contain.
--
-- ── Derived, never authored ─────────────────────────────────────────────────
--
-- §1: nothing is predefined and nobody sits down to model an ontology. These
-- rows come from the same introspection that proposes concepts — a foreign key
-- from one contributing object to another, where both objects already belong to
-- confirmed concepts. No new step for anybody, and no relationship exists that
-- the customer's own database did not already declare.
--
-- ── Directed, and NOT canonically ordered ──────────────────────────────────
--
-- `associations` orders its pair because co-occurrence is symmetric: "A moves
-- with B" and "B moves with A" are one fact. This is the opposite. An invoice
-- references an order; an order does not reference an invoice, and a line item
-- cannot precede the order it belongs to whatever the data says. The direction
-- IS the information, so ordering the pair would destroy the thing the table
-- exists to record.

CREATE TABLE concept_relationships (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /** The concept that holds the reference. */
  from_concept_id uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  /** The concept it points at. */
  to_concept_id   uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /*
   * WITHIN ONE CONNECTION, ALWAYS. A foreign key is a statement inside one
   * system. A relationship ACROSS systems is what the ontology itself is for —
   * two objects being the same concept — and reading one across a connection
   * boundary would be inventing a join nobody declared.
   */
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

  from_object     text        NOT NULL CHECK (length(trim(from_object)) BETWEEN 1 AND 128),
  from_field      text        NOT NULL CHECK (length(trim(from_field)) BETWEEN 1 AND 256),
  to_object       text        NOT NULL CHECK (length(trim(to_object)) BETWEEN 1 AND 128),
  to_field        text        NOT NULL CHECK (length(trim(to_field)) BETWEEN 1 AND 256),

  /*
   * `derived` came from a manifest's declared foreign key. `confirmed` was
   * agreed by a person — for a source whose schema states no constraint even
   * though the relationship is real, which is most CSV and REST sources.
   *
   * WORTH TELLING APART for the reason `concepts.origin` is: whether the
   * customer's schema carries the model, or somebody keeps having to supply it,
   * is the difference between introspection working and introspection being a
   * form with a nicer name.
   */
  origin          text        NOT NULL CHECK (origin IN ('derived', 'confirmed')),

  confirmed_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  /* A concept does not reference itself; a self-join says nothing about two. */
  CONSTRAINT concept_relationships_not_self CHECK (from_concept_id <> to_concept_id),
  CONSTRAINT concept_relationships_confirmed_attributed CHECK (
    origin <> 'confirmed' OR confirmed_by IS NOT NULL
  ),

  /*
   * ONE ROW PER FIELD THAT POINTS. Two fields on the same object may both
   * reference the same target — `billed_to` and `shipped_to` both pointing at
   * customer — and those are two relationships, not one recorded twice.
   */
  CONSTRAINT concept_relationships_unique UNIQUE (
    from_concept_id, to_concept_id, connection_id, from_field
  )
);

/* The walk association makes: given a concept, what does it reach. */
CREATE INDEX concept_relationships_from ON concept_relationships (from_concept_id);
CREATE INDEX concept_relationships_to ON concept_relationships (to_concept_id);

ALTER TABLE concept_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_relationships FORCE  ROW LEVEL SECURITY;

CREATE POLICY concept_relationships_tenant ON concept_relationships
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON concept_relationships TO silo_app;
