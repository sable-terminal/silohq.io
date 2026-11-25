/*
 * Siloes — a concept KEPT in a Silo: a copy of its records, for volume.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * Silo reads live. That is the product's promise and its ceiling: a question
 * over a table reads the table, a connector reads at most a few thousand
 * records at a time, and past that the honest answer is a refusal. An
 * organisation with five million invoices has questions about all of them.
 *
 * A Silo is the opt-in exception to keeping nothing. This lets an organisation
 * that has one KEEP a concept in it: Silo copies each system's records of that
 * concept across, on a schedule, and questions about it are answered from the
 * copy — where the whole table can be read, joined and added up.
 *
 * ── OPTIONAL, PER CONCEPT, AND ONLY EVER BY SOMEBODY'S DECISION ───────────
 *
 * Nothing is kept because a Silo exists. A row here is somebody with
 * `silo.manage` saying "keep this one". An organisation with no rows here
 * never has a question touch the warehouse at all, and removing a row sends
 * that concept's questions back to the live systems.
 *
 * ── One row per SYSTEM the concept spans ──────────────────────────────────
 *
 * Each system is copied on its own and can fail on its own. A concept is
 * answered from the copy only when EVERY system it spans is `synced` — a
 * customer list read half from a copy and half live would be two different
 * moments presented as one.
 *
 * `batch_id` IS WHICH COPY A READER IS SERVED: the last one that finished. A
 * sync writes a new batch beside it and swaps this over only when it is whole,
 * so a question asked during a sync reads yesterday's copy, complete, rather
 * than today's, half written.
 */
CREATE TABLE silo_holdings (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id         uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  object_name     text        NOT NULL CHECK (length(trim(object_name)) BETWEEN 1 AND 128),

  state           text        NOT NULL DEFAULT 'waiting'
                    CHECK (state IN ('waiting', 'syncing', 'synced', 'failed')),
  batch_id        uuid,
  synced_at       timestamptz,
  rows            integer     CHECK (rows IS NULL OR rows >= 0),
  /* Why the last copy did not finish, in words a person can act on. Never a value from a record. */
  failure         text        CHECK (failure IS NULL OR length(failure) BETWEEN 1 AND 500),

  kept_by         uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  kept_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT silo_holdings_unique UNIQUE (concept_id, connection_id, object_name),
  /* A copy that is served has a batch and a time; one that never finished has neither. */
  CONSTRAINT silo_holdings_synced_shape CHECK ((batch_id IS NULL) = (synced_at IS NULL))
);

CREATE INDEX silo_holdings_by_concept ON silo_holdings (concept_id);

ALTER TABLE silo_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_holdings FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_holdings_tenant ON silo_holdings
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_holdings TO silo_app;

/*
 * WHERE THE COPIES LIVE WHEN BIGQUERY IS NOT CONFIGURED — the same stand-in
 * `silo_rows` is for imports, and for the same reason: one shape, so the query
 * path cannot tell which store answered. In production the rows are in
 * BigQuery and this table stays empty.
 */
CREATE TABLE silo_kept_rows (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  holding_id      uuid        NOT NULL REFERENCES silo_holdings(id) ON DELETE CASCADE,
  batch_id        uuid        NOT NULL,
  record          jsonb       NOT NULL,
  synced_at       timestamptz NOT NULL,

  CONSTRAINT silo_kept_rows_record_is_object CHECK (jsonb_typeof(record) = 'object')
);

CREATE INDEX silo_kept_rows_by_batch ON silo_kept_rows (holding_id, batch_id);

ALTER TABLE silo_kept_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_kept_rows FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_kept_rows_tenant ON silo_kept_rows
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON silo_kept_rows TO silo_app;
