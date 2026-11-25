-- 011_cells — which cell a customer lives in, and refusing to serve any other.
--
-- A CELL IS A HARD BOUNDARY. Customer data lives in exactly one and nothing in a
-- cell may read from another, which is what makes "your data is in the UK" a
-- statement about infrastructure rather than about intentions. `cell.config` has
-- said this since the first week and nothing enforced it: `CELL_ID` was
-- validated at boot and then never consulted again.
--
-- ── Two pieces, and only one of them belongs here ───────────────────────────
--
-- `organisations.cell_id` IS CELL-LOCAL AND BELONGS IN THIS DATABASE. It is the
-- row that says "this tenant is ours", and it is what lets a process refuse to
-- serve a tenant that was restored into the wrong place, or reached through a
-- misconfigured connection string.
--
-- `directory_entries` DOES NOT BELONG HERE, and is here anyway. The directory
-- tier is global by definition — it answers "which cell is this person in"
-- BEFORE any cell is chosen, so a copy per cell cannot answer it. In production
-- it is its own database, reached through `DIRECTORY_DATABASE_URL`; in
-- development that variable points back at this one, because standing up a
-- second Postgres to run the tests is a cost with no lesson in it. The
-- separation is in the connection, not in the DDL, and `directory.infra` is
-- deliberately the only thing that touches these rows.
--
-- IT HOLDS A HASH AND A CELL ID AND NOTHING ELSE. The directory is the one
-- component every cell can reach, so it is the one component whose compromise
-- would be global — which is why it must not be worth compromising. A hashed
-- address answers "where do I send this login" and cannot be turned back into a
-- customer list.

ALTER TABLE organisations
  ADD COLUMN cell_id text NOT NULL DEFAULT 'local'
    CHECK (length(trim(cell_id)) BETWEEN 1 AND 64);

/*
 * The default exists for this migration and is dropped immediately. Leaving it
 * would mean a future insert that forgets the cell silently claims to be in
 * whichever one was current when this file was written.
 */
ALTER TABLE organisations ALTER COLUMN cell_id DROP DEFAULT;

CREATE INDEX organisations_by_cell ON organisations (cell_id);

CREATE TABLE directory_entries (
  /*
   * SHA-256 OF THE LOWERCASED ADDRESS, keyed with a secret held by the
   * directory. A bare hash of an email is reversible in practice — the space of
   * real addresses is small enough to enumerate — so an unkeyed digest would be
   * a customer list with extra steps.
   */
  email_hash  text        PRIMARY KEY CHECK (length(email_hash) = 64),
  cell_id     text        NOT NULL CHECK (length(trim(cell_id)) BETWEEN 1 AND 64),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX directory_entries_by_cell ON directory_entries (cell_id);

/*
 * NO ROW LEVEL SECURITY, AND THAT IS NOT AN OVERSIGHT. There is no tenant to
 * scope a directory row to — the whole point is that it is consulted before any
 * tenant is known — and it contains nothing tenant-specific to protect. What
 * protects it is that it holds a keyed hash and a cell name, and that
 * `directory.infra` is the only code with a connection to it.
 */
GRANT SELECT, INSERT, UPDATE ON directory_entries TO silo_app;

/*
 * Recording where somebody lives. Upsert, because an invitation into a second
 * organisation must not move an existing person to a different cell — the first
 * answer wins, and a person who genuinely needs to move is a migration somebody
 * runs deliberately.
 */
CREATE OR REPLACE FUNCTION directory_record(p_email_hash text, p_cell_id text)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  INSERT INTO directory_entries (email_hash, cell_id)
  VALUES (p_email_hash, p_cell_id)
  ON CONFLICT (email_hash) DO UPDATE SET updated_at = now()
  RETURNING cell_id;
$$;

GRANT EXECUTE ON FUNCTION directory_record(text, text) TO silo_app;
