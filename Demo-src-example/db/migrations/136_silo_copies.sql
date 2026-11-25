/*
 * Siloes — the copies a kept concept has had, and keeping more than the last.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * 135 keeps one copy of a concept and replaces it each day. That answers "how
 * many invoices are there". It cannot answer "how many were there at quarter
 * end" or "which deals changed stage this week" — and most of the systems an
 * organisation runs cannot either, because they hold what is true now and
 * nothing of what was.
 *
 * `history` on a holding says: do not replace, keep. Each finished copy then
 * stays, a row here, until it is older than the Silo's own window, and a
 * question can be asked of the copy made nearest a date, or of what differs
 * between two of them.
 *
 * ── OPTIONAL, PER CONCEPT, AND OFF UNLESS SOMEBODY TURNS IT ON ────────────
 *
 * A concept kept without it holds one copy, as before, and one row here: the
 * copy being served. Nothing about a question changes for it.
 *
 * ── BOUNDED BY THE SILO'S WINDOW, WHICH THE SCHEMA CAPS ───────────────────
 *
 * A copy is unreadable once it is older than `siloes.retention_days` (never
 * more than 730, by CHECK), and the retention sweep deletes it. That is the
 * same bound an imported file has, enforced the same two ways.
 *
 * ── `sync_started_at` ─────────────────────────────────────────────────────
 *
 * A copy being made is `syncing`, and the scheduler leaves those alone. A job
 * killed halfway left one `syncing` for ever, and its concept never copied
 * again. With the time it started, one stuck for hours is taken up again.
 */
ALTER TABLE silo_holdings
  ADD COLUMN history         boolean     NOT NULL DEFAULT false,
  ADD COLUMN sync_started_at timestamptz;

CREATE TABLE silo_copies (
  /* The batch: what every row of this copy carries. */
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  holding_id      uuid        NOT NULL REFERENCES silo_holdings(id) ON DELETE CASCADE,
  /* When the copy was begun: the moment it is a picture of, to within the time it took to read. */
  copied_at       timestamptz NOT NULL,
  rows            integer     NOT NULL CHECK (rows >= 0)
);

CREATE INDEX silo_copies_by_holding ON silo_copies (holding_id, copied_at DESC);

ALTER TABLE silo_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_copies FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_copies_tenant ON silo_copies
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON silo_copies TO silo_app;

/* The copies already being served are copies. */
INSERT INTO silo_copies (id, organisation_id, holding_id, copied_at, rows)
SELECT batch_id, organisation_id, id, synced_at, COALESCE(rows, 0)
  FROM silo_holdings
 WHERE batch_id IS NOT NULL;
