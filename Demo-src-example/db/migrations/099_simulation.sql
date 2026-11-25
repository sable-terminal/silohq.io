/*
 * 099 — running the graph, and what a run leaves behind.
 *
 * ── §5: "A simulation is saved as a scenario" ──────────────────────────────
 *
 * There is no unsaved simulation. "The stated failure, the graph version, the
 * mode, and the bounds" is the whole of what a scenario holds, and §5's claim
 * that "a scenario asked again next month is a new result, and the two are
 * comparable because the scenario is the same" only works if the question
 * outlives the answer. So the question is kept and the answers expire.
 *
 * ── THE INDEX 097 BUILT POINTS THE WRONG WAY, AND IT MATTERS ──────────────
 *
 * §2.2 takes an edge's direction from the ontology relationship, and a
 * relationship runs from the object HOLDING the foreign key to the one it
 * points at: `invoices.order_id → orders.id`. The holder is the dependent — a
 * foreign key constraint says precisely that the referencing row cannot exist
 * without the referenced one. So `from` waits on `to`, and propagation runs the
 * other way: a failure at `to` reaches the `from` side.
 *
 * 097 indexed `from_concept_id`, which is the side the walk arrives at rather
 * than the side it searches by. Every hop would have been a sequential scan.
 * Migrations are immutable once applied, so it is replaced here rather than
 * edited there.
 */

DROP INDEX dependency_edges_walkable;

/* Given a failed concept, which concepts wait on it. */
CREATE INDEX dependency_edges_walkable
  ON dependency_edges (to_concept_id)
  WHERE confirmed_at IS NOT NULL AND retired_at IS NULL;

/*
 * §5 — the question.
 *
 * ── §8: "organisation, owner, name, stated failure, mode, bounds, graph
 * version, created at" ────────────────────────────────────────────────────
 *
 * The graph version recorded here is the one the scenario was WRITTEN against.
 * §5 — "Graph version is recorded on every result. An edge confirmed
 * differently since means the two results are not comparable, and the product
 * says so rather than letting someone compare them." Each run records its own
 * as well, and the difference between the two is exactly the warning.
 */
CREATE TABLE scenarios (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  owner_id            uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  name                text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /* §3.1 — "a stated failure on an entity". Which concept, and which of its
     records, by the identifier their own system states. */
  failed_concept_id   uuid        NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,
  failed_entity_refs  text[]      NOT NULL CHECK (cardinality(failed_entity_refs) BETWEEN 1 AND 100),

  /* §4 ships second; the column admits it from the start so saved scenarios do
     not need rewriting when it does. */
  mode                text        NOT NULL DEFAULT 'deterministic'
                                  CHECK (mode IN ('deterministic', 'probabilistic')),

  /* §3.1 — "Bounded per hop, as traversal already is." */
  max_hops            integer     NOT NULL CHECK (max_hops BETWEEN 1 AND 10),
  max_per_hop         integer     NOT NULL CHECK (max_per_hop BETWEEN 1 AND 1000),

  graph_version       text        NOT NULL CHECK (length(graph_version) = 64),

  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE UNIQUE INDEX scenarios_name_unique
  ON scenarios (organisation_id, lower(name)) WHERE deleted_at IS NULL;

CREATE INDEX scenarios_by_owner ON scenarios (owner_id, created_at DESC) WHERE deleted_at IS NULL;

/*
 * §8 — "scenario, mode, iterations, graph version, started at, completed at,
 * bounded at hop, token transaction."
 *
 * ── `spent_from_period` IS THE "TOKEN TRANSACTION" ────────────────────────
 *
 * §6 — "Simulation is a separate allowance from tokens. Different cost base,
 * and a shared pool would let a customer buy an expensive capability with cheap
 * units." That allowance is a counter per membership per period rather than a
 * ledger of rows, so what ties a run to what it cost is the period it was taken
 * from. NOT NULL, because a run that was never metered is a run somebody got
 * for nothing and nothing would show it.
 *
 * ── `bounded_at_hop` IS THE HONEST FAILURE ────────────────────────────────
 *
 * §3.1 — "Fan-out that exceeds the bound stops and names the hop rather than
 * truncating." A truncated answer looks complete, which is the one thing this
 * product keeps refusing to produce.
 */
CREATE TABLE simulation_runs (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  scenario_id         uuid        NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  run_by              uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  mode                text        NOT NULL CHECK (mode IN ('deterministic', 'probabilistic')),

  /* §4.2 — "Iteration count is bounded and stated." One, deterministically. */
  iterations          integer     NOT NULL CHECK (iterations >= 1),

  graph_version       text        NOT NULL CHECK (length(graph_version) = 64),

  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  bounded_at_hop      integer     CHECK (bounded_at_hop IS NULL OR bounded_at_hop >= 0),

  spent_from_period   timestamptz NOT NULL,

  CONSTRAINT simulation_runs_completed_after CHECK (
    completed_at IS NULL OR completed_at >= started_at
  )
);

CREATE INDEX simulation_runs_by_scenario ON simulation_runs (scenario_id, started_at DESC);

/*
 * §8 — "run, affected entity, path, accumulated delay, probability, edge
 * sources on path."
 *
 * ── §3.1: "Output is named records, not proportions" ──────────────────────
 *
 * "The specific orders, jobs or obligations that do not complete, and the chain
 * of edges from the cause to each of them." One row per record reached.
 *
 * ── IDENTIFIERS, NEVER CONTENTS ───────────────────────────────────────────
 *
 * `entity_ref` is the identifier the record's own system states — the same
 * thing a walk returns and a `QueriedEntity` member holds. No field value from
 * any source system reaches this table, which is what keeps the storage
 * disclosure true through a subsystem that persists an answer.
 *
 * ── AND IT EXPIRES ────────────────────────────────────────────────────────
 *
 * §5 — "Re-running uses the current data and the current graph." A result is a
 * statement about the data on one day, so it has a shelf life by nature. The
 * ceiling is a CHECK rather than a sweep's good intentions, matching every
 * other bounded store in the product.
 */
CREATE TABLE simulation_results (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  run_id              uuid        NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,

  affected_concept_id uuid        NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,
  entity_ref          text        NOT NULL CHECK (length(trim(entity_ref)) BETWEEN 1 AND 512),

  /* The chain of edges from the cause to this record, in order. Edge ids and
     concept ids: the path §3.1 requires, with nothing in it to read. */
  path                jsonb       NOT NULL,
  hops                integer     NOT NULL CHECK (hops >= 1),

  /* §3.1 — the accumulated delay. Hours, because the units on an edge differ
     and a stored figure that needs a unit beside it gets compared without one. */
  delay_hours         numeric     NOT NULL CHECK (delay_hours >= 0),

  /* §4.3 — null until probabilistic mode exists. A deterministic run makes no
     probability claim, and 1.0 would be exactly that claim. */
  probability         numeric     CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),

  /* §2.2 — "Every edge records its source, and it travels with every result the
     edge contributed to... the output must say which." */
  edge_sources        text[]      NOT NULL CHECK (cardinality(edge_sources) >= 1),

  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,

  CONSTRAINT simulation_results_retention CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX simulation_results_by_run ON simulation_results (run_id);
CREATE INDEX simulation_results_expiring ON simulation_results (expires_at);

ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE  ROW LEVEL SECURITY;
CREATE POLICY scenarios_tenant ON scenarios
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE simulation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY simulation_runs_tenant ON simulation_runs
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE simulation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_results FORCE  ROW LEVEL SECURITY;
CREATE POLICY simulation_results_tenant ON simulation_results
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON scenarios TO silo_app;
GRANT SELECT, INSERT, UPDATE ON simulation_runs TO silo_app;
GRANT SELECT, INSERT, DELETE ON simulation_results TO silo_app;

/*
 * §7 — the two remaining permissions.
 *
 * `simulation.run` IS ORDINARY. Running is reading: it walks a graph somebody
 * already confirmed and queries records the runner can already see. §7's
 * marking rule does the narrowing — "a simulation whose path crosses a concept
 * the runner lacks clearance for stops at that edge and reports it" — so the
 * permission does not need to.
 *
 * `simulation.share` IS NOT ON `Member`, for the same reason sharing anything
 * else is not: it widens who can see an answer, and the answer names records.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('simulation.run', 'simulation', 'Run a simulation against the confirmed graph', false),
  ('simulation.share', 'simulation', 'Share a scenario with other people', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'simulation.run'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin', 'Member')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'simulation.share'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
