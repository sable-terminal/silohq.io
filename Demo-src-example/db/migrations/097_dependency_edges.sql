/*
 * 097 — a graph of what waits on what, which nothing else in Silo needs.
 *
 * ── §1: "Identity is not causation" ────────────────────────────────────────
 *
 * "Foreign keys state that an invoice points at an order. They do not state
 * that the order waits on the supplier, or by how long, or whether it can
 * proceed degraded... nothing in the schema carries the difference."
 *
 * This table is that difference. It is not derived from the ontology and cannot
 * be: the ontology resolves identity across systems, and an edge here is an
 * assertion about dependency that only a person can make.
 *
 * ── §2.3: "No edge is live until a person confirms it" ─────────────────────
 *
 * `confirmed_at IS NULL` is a proposal, and a proposal is not part of the
 * graph. §3 walks confirmed edges only; §2.3 says a simulation whose path
 * crosses an unconfirmed edge "stops there and says so", because "silently
 * routing around it produces a shorter answer that looks complete".
 *
 * ── A PROPOSAL CANNOT KNOW THE THINGS THAT MATTER ─────────────────────────
 *
 * §2.2 — structural derivation gives "candidate edges and their direction", and
 * nothing else. It cannot know whether the dependency is hard or soft, or how
 * long it takes. So `kind` and the lead time are NULLABLE on a proposal and
 * REQUIRED on a confirmed edge, enforced below. A default of `hard` with a lead
 * time of zero would be a guess wearing the clothes of a confirmed fact.
 *
 * ── §2.1: resource edges exist in the CHECK before they are built ─────────
 *
 * "Deferred to phase two, but the edge kind exists from the start so the graph
 * does not need rebuilding." Accepting the value is free; what phase two adds
 * is contention, which is arithmetic rather than a column.
 */

CREATE TABLE dependency_edges (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §2.1 — concept to concept. Entities are reached by walking, not by storing. */
  from_concept_id uuid        NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,
  to_concept_id   uuid        NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,

  /* Null until somebody decides which it is. */
  kind            text        CHECK (kind IN ('hard', 'soft', 'resource')),

  /* §2.1 — a value and a unit, because "three" is not a lead time. */
  lead_time_value numeric     CHECK (lead_time_value IS NULL OR lead_time_value >= 0),
  lead_time_unit  text        CHECK (lead_time_unit IN ('hours', 'days', 'weeks')),

  /* §2.1 — how long the downstream thing runs on hand before the failure lands. */
  buffer_value    numeric     CHECK (buffer_value IS NULL OR buffer_value >= 0),
  buffer_unit     text        CHECK (buffer_unit IN ('hours', 'days', 'weeks')),

  /*
   * §2.2 — "Every edge records its source, and it travels with every result the
   * edge contributed to. A simulation resting on stated lead times is a
   * different claim from one resting on four hundred observations."
   */
  source          text        NOT NULL CHECK (source IN ('structure', 'history', 'stated')),
  /* What the source points at: a relationship id, or an observation row. */
  evidence_ref    uuid,

  confirmed_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz,
  retired_at      timestamptz,

  /* §5 — bumped on every revision, so two results can be told apart. */
  version         integer     NOT NULL DEFAULT 1 CHECK (version >= 1),

  proposed_at     timestamptz NOT NULL DEFAULT now(),

  /* §1 — a concept does not wait on itself. */
  CONSTRAINT dependency_edges_not_self CHECK (from_concept_id <> to_concept_id),

  CONSTRAINT dependency_edges_confirmed_together CHECK (
    (confirmed_by IS NULL) = (confirmed_at IS NULL)
  ),

  /*
   * §2.3 — A CONFIRMED EDGE CARRIES WHAT A SIMULATION NEEDS. Nothing may be
   * confirmed without the kind and the lead time, because the walk cannot ask
   * afterwards and would otherwise treat a missing lead time as nought.
   */
  CONSTRAINT dependency_edges_confirmed_is_complete CHECK (
    confirmed_at IS NULL OR (kind IS NOT NULL AND lead_time_value IS NOT NULL AND lead_time_unit IS NOT NULL)
  ),

  CONSTRAINT dependency_edges_lead_time_has_unit CHECK (
    (lead_time_value IS NULL) = (lead_time_unit IS NULL)
  ),
  CONSTRAINT dependency_edges_buffer_has_unit CHECK (
    (buffer_value IS NULL) = (buffer_unit IS NULL)
  )
);

/*
 * One live edge per pair. A second proposal for a pair somebody already
 * confirmed would give the walk two answers and no way to choose.
 */
CREATE UNIQUE INDEX dependency_edges_live
  ON dependency_edges (organisation_id, from_concept_id, to_concept_id)
  WHERE retired_at IS NULL;

/* What the walk reads: confirmed, not retired, outgoing from a concept. */
CREATE INDEX dependency_edges_walkable
  ON dependency_edges (from_concept_id)
  WHERE confirmed_at IS NOT NULL AND retired_at IS NULL;

ALTER TABLE dependency_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE dependency_edges FORCE  ROW LEVEL SECURITY;
CREATE POLICY dependency_edges_tenant ON dependency_edges
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON dependency_edges TO silo_app;

/*
 * §7 — `graph.propose`: "Run derivation to propose edges."
 *
 * ORDINARY, BECAUSE A PROPOSAL IS NOT A CLAIM. Derivation reads the ontology
 * and writes rows nothing walks. `graph.confirm` is the consequential one and
 * arrives with the code that enforces it.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('graph.propose', 'simulation', 'Propose dependency edges from the ontology', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'graph.propose'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
