/*
 * 124 — what a connection's admin confirmed, pinned (MANIFEST-V2 §9.2, F19, F20).
 *
 * ── A CREDENTIAL GOES ONLY WHERE SOMEBODY SAID IT MAY ─────────────────────
 *
 * The origins a connection's credential is sent to — the resolved base URL,
 * every OAuth endpoint, a login URL — were computed from the document each time
 * a request was made. That is right until the document changes: a new version
 * that adds an origin would have sent the credential there with nobody asked.
 * So the set is written down when the connection is made, by the person making
 * it, and a request to anywhere else carries no credential at all.
 *
 * ── A STATEMENT RUNS ONLY IF IT IS THE ONE THAT WAS SHOWN ────────────────
 *
 * A SQL connector may carry a read-only statement of its own. It is shown to the
 * admin who connects, and its hash is pinned here; a changed statement is not
 * run until somebody confirms it.
 *
 * `kind` SAYS WHICH. An origin is kept as written (`https://host:port`); a
 * statement as the SHA-256 of its text.
 */

CREATE TABLE connection_pins (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind            text        NOT NULL CHECK (kind IN ('origin', 'statement')),
  value           text        NOT NULL CHECK (length(value) BETWEEN 1 AND 2048),
  confirmed_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, kind, value),
  CONSTRAINT connection_pins_statement_is_a_hash CHECK (kind <> 'statement' OR value ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connection_pins_origin_is_an_origin CHECK (kind <> 'origin' OR value ~ '^https?://[^/?#]+$')
);

ALTER TABLE connection_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_pins FORCE  ROW LEVEL SECURITY;
CREATE POLICY connection_pins_tenant ON connection_pins
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* Replaced whole when an admin re-confirms. */
GRANT SELECT, INSERT, DELETE ON connection_pins TO silo_app;
