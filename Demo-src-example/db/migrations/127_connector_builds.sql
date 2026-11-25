/*
 * 127 — a connector being built and tested for somebody (MANIFEST-V2 §5, route 2).
 *
 * ── THE AI FINISHES THE CONNECTOR, THEN A PERSON LOOKS ────────────────────
 *
 * A draft the model wrote once and handed to the builder left the person to
 * finish a technical document. A build instead holds what is needed to test the
 * draft against the real system — the credential the person gave for it — so
 * Silo can read, see what came back, repair, and read again, and only then
 * show the person what it found.
 *
 * ── THE CREDENTIAL IS HELD FOR THE BUILD AND NO LONGER ────────────────────
 *
 * Sealed like any connection's (bytea, never text), and bounded by the schema:
 * a build cannot outlive a day, reads ignore an expired one, and connecting
 * moves the credential onto the new connection and clears it here. What the
 * build keeps about the system is words and counts — `progress` — never a
 * record.
 */

CREATE TABLE connector_builds (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  draft_id        uuid        NOT NULL REFERENCES connector_drafts(id) ON DELETE CASCADE,
  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  status          text        NOT NULL CHECK (status IN ('needs_credential', 'testing', 'ready', 'stuck', 'unsupported', 'connected')),
  rounds          integer     NOT NULL DEFAULT 0 CHECK (rounds BETWEEN 0 AND 20),
  /* Where the documentation was, so a repair can read it again. Never the text. */
  source_url      text        CHECK (source_url IS NULL OR length(source_url) <= 2048),
  strategy        text        CHECK (strategy IS NULL OR length(strategy) <= 64),
  sealed          bytea,
  wrapped_key     bytea,
  key_reference   text        CHECK (key_reference IS NULL OR key_reference NOT LIKE '%BEGIN%'),
  parameters      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  progress        jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(progress) = 'array'),
  /* One round at a time: a second press while a round runs waits rather than paying for another. */
  busy_until      timestamptz,
  connection_id   uuid        REFERENCES connections(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT connector_builds_bounded CHECK (expires_at <= created_at + interval '24 hours'),
  CONSTRAINT connector_builds_sealed_whole CHECK (
    (sealed IS NULL AND wrapped_key IS NULL AND key_reference IS NULL)
    OR (sealed IS NOT NULL AND wrapped_key IS NOT NULL AND key_reference IS NOT NULL)
  ),
  CONSTRAINT connector_builds_connected_holds_nothing CHECK (status <> 'connected' OR sealed IS NULL)
);

CREATE INDEX connector_builds_expiry ON connector_builds (expires_at);

ALTER TABLE connector_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_builds FORCE  ROW LEVEL SECURITY;
CREATE POLICY connector_builds_tenant ON connector_builds
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_builds TO silo_app;
