/*
 * Siloes — what Silo has worked out about a kept concept, kept as tables.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * Every question about a concept two systems hold works out, again, which
 * record in one is which record in the other, which fields they call
 * differently, and which values they write differently. It is worked out
 * correctly each time and then thrown away — so it cannot be looked at, cannot
 * be used by anything else, and a question about one record cannot draw on
 * what ten thousand records would have shown.
 *
 * For a concept somebody has chosen to KEEP in a Silo, this keeps it too, in
 * the same Silo, remade at every copy:
 *
 *   matches   which record in each system is the same thing
 *   fields    which column in each system is each of the concept's fields
 *   values    the pairs of values two systems give for one field of the same
 *             records: `UK` beside `United Kingdom`, `DE` beside `Germany`
 *
 * ── ONLY FOR A CONCEPT THAT IS KEPT, AND ONLY WHAT ITS COPIES SHOW ────────
 *
 * Nothing here is fetched from anybody's systems. It is worked out from the
 * copies already in the Silo, lives where they live, is removed when the
 * concept stops being kept, and is unreadable past the Silo's window. An
 * organisation that keeps nothing has no rows here and never will.
 *
 * `silo_learned` IS WHICH TABLE IS BEING SERVED, one row per concept and kind,
 * with counts beside it for the Silo's own page: how many records matched,
 * how many pairs. Counts only. The rows themselves are in BigQuery in
 * production, and in `silo_learned_rows` — the stand-in — everywhere else.
 */
CREATE TABLE silo_learned (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id         uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind            text        NOT NULL CHECK (kind IN ('matches', 'fields', 'values')),
  batch_id        uuid        NOT NULL,
  made_at         timestamptz NOT NULL,
  rows            integer     NOT NULL CHECK (rows >= 0),
  /* Counts, for the Silo's page. Never a value from a record. */
  summary         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),

  CONSTRAINT silo_learned_unique UNIQUE (concept_id, kind)
);

ALTER TABLE silo_learned ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_learned FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_learned_tenant ON silo_learned
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_learned TO silo_app;

CREATE TABLE silo_learned_rows (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind            text        NOT NULL CHECK (kind IN ('matches', 'fields', 'values')),
  batch_id        uuid        NOT NULL,
  record          jsonb       NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  made_at         timestamptz NOT NULL
);

CREATE INDEX silo_learned_rows_by_batch ON silo_learned_rows (concept_id, kind, batch_id);

ALTER TABLE silo_learned_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_learned_rows FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_learned_rows_tenant ON silo_learned_rows
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON silo_learned_rows TO silo_app;
