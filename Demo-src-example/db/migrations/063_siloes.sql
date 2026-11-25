/*
 * §10 — Siloes. Capture: the one place this architecture holds a customer's
 * values, and the narrowest record that can answer the question.
 *
 * ── What capture is for ────────────────────────────────────────────────────
 *
 * A federated query sees the CURRENT state of a source and discards it. Where a
 * source overwrites rather than appends, the change is gone: a value said one
 * thing yesterday and says another today, and nothing recorded the transition.
 *
 * Three detectors need that record — timing deviation, drift and recurrence.
 * The other seven run federated and always will.
 *
 * ── IT STORES TRANSITIONS, NOT RECORDS ─────────────────────────────────────
 *
 * An entity reference, a field, the value before, the value after, when it was
 * seen and which connection it came from. NOTHING ELSE FROM THE ROW. Keeping
 * the record this narrow is what makes the disclosure a sentence rather than a
 * paragraph, and it is the whole reason capture can be defended.
 *
 * ── Postgres, not BigQuery ─────────────────────────────────────────────────
 *
 * Narrow rows with a clear access pattern, and Postgres already carries
 * tenancy, row level security and markings. Putting capture in BigQuery would
 * mean solving residency, access control and cost metering for the smallest
 * possible payload. BigQuery is the right answer for import, later.
 */

/* ── The Silo ────────────────────────────────────────────────────────────── */

/*
 * RETENTION IS REQUIRED AT CREATION AND NEVER DEFAULTED SILENTLY. A window
 * nobody chose is a window nobody agreed to, and the first question anybody
 * asks about stored data is how long it is kept.
 */
CREATE TABLE siloes (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  /* §11 — what it is for, in the customer's words, shown in the disclosure. */
  purpose         text        NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 1000),

  retention_days  integer     NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),

  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,

  CONSTRAINT siloes_name_unique UNIQUE (organisation_id, name)
);

CREATE INDEX siloes_live ON siloes (organisation_id) WHERE disabled_at IS NULL;

ALTER TABLE siloes ENABLE ROW LEVEL SECURITY;
ALTER TABLE siloes FORCE  ROW LEVEL SECURITY;
CREATE POLICY siloes_tenant ON siloes
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON siloes TO silo_app;

/* ── What it captures ────────────────────────────────────────────────────── */

/*
 * ONE CONCEPT AT A TIME, AND NOTHING CASCADES. The relationship graph is
 * connected, so transitive enabling would reach most of the estate in two hops.
 * A customer who enabled capture on one thing must not discover they are
 * storing twenty. Related concepts are PROPOSED with the relationship shown;
 * each needs its own confirmation.
 */
CREATE TABLE silo_concepts (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id           uuid        NOT NULL REFERENCES siloes(id) ON DELETE CASCADE,
  concept_id        uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /*
   * NOMINATED, NEVER ALL. Capture is per field because the disclosure is per
   * field: "we keep what changed about these three columns" is defensible in a
   * way "we keep what changed" is not.
   */
  nominated_fields  text[]      NOT NULL CHECK (cardinality(nominated_fields) BETWEEN 1 AND 64),

  added_by          uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  added_at          timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz
);

/* One live row per concept per Silo; removed ones stay for the audit trail. */
CREATE UNIQUE INDEX silo_concepts_one_live
  ON silo_concepts (silo_id, concept_id) WHERE removed_at IS NULL;

ALTER TABLE silo_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_concepts FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_concepts_tenant ON silo_concepts
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON silo_concepts TO silo_app;

/* ── What a transition is compared against ───────────────────────────────── */

/*
 * §5 — NO TRANSITION ON FIRST SIGHTING. The first observation is a baseline, so
 * capture produces nothing until a concept has been queried twice. Stated in
 * the product rather than left to be discovered.
 */
CREATE TABLE silo_baselines (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id           uuid        NOT NULL REFERENCES siloes(id) ON DELETE CASCADE,
  concept_id        uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  entity_ref        text        NOT NULL,
  field_path        text        NOT NULL,
  last_value        text,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT silo_baselines_unique UNIQUE (silo_id, concept_id, entity_ref, field_path)
);

ALTER TABLE silo_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_baselines FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_baselines_tenant ON silo_baselines
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_baselines TO silo_app;

/* ── The transitions themselves ──────────────────────────────────────────── */

/*
 * §7 — PARTITIONED BY OBSERVED DATE, so retention is a partition DROP rather
 * than a delete. A retention window enforced by `DELETE FROM` on a large table
 * is a window that quietly stops being enforced the first time the sweep times
 * out.
 *
 * The partition key includes `organisation_id` so a tenant's data is separable
 * at the storage layer as well as by policy.
 */
CREATE TABLE transitions (
  id                uuid        NOT NULL,
  organisation_id   uuid        NOT NULL,
  silo_id           uuid        NOT NULL,
  concept_id        uuid        NOT NULL,
  connection_id     uuid        NOT NULL,

  entity_ref        text        NOT NULL,
  field_path        text        NOT NULL,

  /*
   * ── THE ONE PLACE THIS ARCHITECTURE HOLDS CUSTOMER VALUES ───────────────
   *
   * Everything else in the product carries references, counts and statistics.
   * These two columns are the exception and the entire subject of the
   * disclosure. Nullable because a field appearing or disappearing is itself a
   * transition worth recording.
   */
  previous_value    text,
  new_value         text,

  observed_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organisation_id, observed_at, id)
) PARTITION BY RANGE (observed_at);

CREATE INDEX transitions_lookup
  ON transitions (silo_id, concept_id, entity_ref, field_path, observed_at DESC);

ALTER TABLE transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transitions FORCE  ROW LEVEL SECURITY;
CREATE POLICY transitions_tenant ON transitions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON transitions TO silo_app;

/*
 * A DEFAULT PARTITION, so a write can never fail for want of one. The sweep
 * creates dated partitions ahead of time; this is what catches anything that
 * arrives before it has run.
 */
CREATE TABLE transitions_default PARTITION OF transitions DEFAULT;

/* ── Wipe receipts ───────────────────────────────────────────────────────── */

/*
 * §9 — "PROVE YOU DELETED IT" IS THE NEXT QUESTION. The receipt is what
 * survives a purge, because the thing it describes does not.
 */
CREATE TABLE purge_receipts (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id           uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,

  scope             text        NOT NULL CHECK (scope IN ('entity', 'concept', 'silo')),
  /* What was named: an entity ref, a concept id, or nothing for a whole Silo. */
  target            text,

  transitions_removed integer   NOT NULL CHECK (transitions_removed >= 0),
  baselines_removed   integer   NOT NULL CHECK (baselines_removed >= 0),
  /* §9 — which detectors stop working, said at the time rather than discovered. */
  detectors_affected  text[]    NOT NULL DEFAULT '{}',

  requested_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  approved_by       uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  completed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX purge_receipts_by_silo ON purge_receipts (silo_id, completed_at DESC);

ALTER TABLE purge_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purge_receipts FORCE  ROW LEVEL SECURITY;
CREATE POLICY purge_receipts_tenant ON purge_receipts
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON purge_receipts TO silo_app;

/* ── §4 The permissions ──────────────────────────────────────────────────── */

/*
 * `silo.enable` ALREADY EXISTS, super admin only. The other three are new.
 *
 * `silo.purge` IS SEPARATE FROM `silo.manage` and that separation is the point:
 * shortening a retention window destroys data, so it requires purge rather than
 * manage — otherwise purge is bypassed by setting retention to a day.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('silo.create', 'silo', 'Create a Silo, its purpose and its retention window', false),
  ('silo.manage', 'silo', 'Add and remove concepts and nominated fields',        false),
  ('silo.purge',  'silo', 'Delete captured data. Destructive and irreversible',  false);
