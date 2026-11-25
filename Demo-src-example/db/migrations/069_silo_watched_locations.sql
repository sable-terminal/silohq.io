/*
 * 069 — watched locations.
 *
 * Import §2: "A drop point that accumulates. Files are picked up on a schedule
 * and processed as they arrive. Both produce the same result. The difference is
 * trigger, not treatment."
 *
 * ── A folder the organisation controls, read over SFTP ─────────────────────
 *
 * `location` is `sftp://host:port/directory`, already allowed by 067 for a
 * watched source. Nothing is ever written to it or deleted from it: the folder
 * belongs to whoever exports into it, and a pickup that moved files would be
 * two systems processing the same file for as long as anybody was polling it.
 *
 * ── The host key is pinned, not trusted on first use ───────────────────────
 *
 * A credential sent to whichever server answers is a credential given away.
 * The fingerprint is confirmed by a person when the location is configured, and
 * a server presenting any other key is refused on every pickup.
 *
 * ── A cursor, not a list of what was taken ─────────────────────────────────
 *
 * Files modified after the cursor are new. A ledger of filenames already
 * imported would re-import a file the moment it was purged or aged out of the
 * window, because it would still be sitting in the folder — so a purge would
 * undo itself on the next schedule, and a retention window would never close.
 * The names at exactly the cursor's instant are kept, and only those, because
 * two files can share a modification time.
 *
 * ── The credential is sealed, in its own table ─────────────────────────────
 *
 * The same envelope as `connection_credentials`, bound to the source by its
 * additional data so a sealed value copied to another row does not open. It is
 * destroyed when the location stops being watched, and a Silo wipe destroys it
 * with everything else.
 */

ALTER TABLE silo_sources ADD COLUMN watch_pattern text
  CHECK (watch_pattern IS NULL OR length(watch_pattern) BETWEEN 1 AND 128);
ALTER TABLE silo_sources ADD COLUMN host_fingerprint text
  CHECK (host_fingerprint IS NULL OR host_fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$');
ALTER TABLE silo_sources ADD COLUMN watch_cursor timestamptz;
ALTER TABLE silo_sources ADD COLUMN watch_cursor_names text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(watch_cursor_names) <= 1000);
ALTER TABLE silo_sources ADD COLUMN last_polled_at timestamptz;
ALTER TABLE silo_sources ADD COLUMN poll_failure_code text
  CHECK (poll_failure_code IS NULL OR poll_failure_code ~ '^[a-z_]+\.[a-z_]+$');

ALTER TABLE silo_sources ADD CONSTRAINT silo_sources_watch_shape
  CHECK ((kind = 'watched') = (watch_pattern IS NOT NULL AND host_fingerprint IS NOT NULL));

CREATE INDEX silo_sources_watched_due ON silo_sources (last_polled_at)
  WHERE kind = 'watched' AND retired_at IS NULL;

CREATE TABLE silo_source_credentials (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  source_id       uuid        NOT NULL UNIQUE REFERENCES silo_sources(id) ON DELETE RESTRICT,

  /* Not secret: it is what the folder's owner sees in their own access log. */
  username        text        NOT NULL CHECK (length(username) BETWEEN 1 AND 128),

  /* `bytea`, never text, for the reason `connection_credentials` gives. */
  sealed          bytea       NOT NULL,
  wrapped_key     bytea       NOT NULL,
  key_reference   text        NOT NULL CHECK (key_reference NOT LIKE '%BEGIN%'),

  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE silo_source_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_source_credentials FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_source_credentials_tenant ON silo_source_credentials
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON silo_source_credentials TO silo_app;
