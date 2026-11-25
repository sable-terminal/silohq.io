-- 015_connection_credentials — sealed secrets, and the OAuth flow in progress.
--
-- ITS OWN MIGRATION BECAUSE IT HAS ITS OWN CHARACTERISTICS. Different backup
-- retention, different access review, and a down migration that refuses.

CREATE TABLE connection_credentials (
  id              uuid        PRIMARY KEY,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,

  auth_strategy   text        NOT NULL REFERENCES connector_auth_strategies(strategy),

  /*
   * `bytea`, NEVER text. Base64 in a text column invites something to log it,
   * diff it, or index it, and every one of those puts ciphertext somewhere it
   * was not meant to be. The envelope is the same one `mfa_factors` uses.
   */
  sealed          bytea       NOT NULL,
  wrapped_key     bytea       NOT NULL,
  /** A KMS resource name identifying the KEK VERSION. Never a key. */
  key_reference   text        NOT NULL CHECK (key_reference NOT LIKE '%BEGIN%'),

  /*
   * FOR RECOGNITION, NEVER FOR AUTHENTICATION. Four characters of a secret
   * narrows nothing, and "the key ending 8f2c" is how an administrator tells
   * which credential is in which environment.
   */
  last_four       text        CHECK (last_four IS NULL OR length(last_four) = 4),

  /** §4.3: checked against what the manifest requires, at connect time. */
  granted_scopes  text[]      NOT NULL DEFAULT '{}',

  expires_at      timestamptz,
  refreshed_at    timestamptz,
  /*
   * A REFRESH THAT KEEPS FAILING IS AN AUTH ERROR REQUIRING RECONNECTION, never
   * an empty result. The count is what lets the engine stop retrying and say so
   * rather than returning nothing and looking like the system is empty.
   */
  refresh_failure_count integer NOT NULL DEFAULT 0 CHECK (refresh_failure_count >= 0),

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One per strategy per connection: a second makes "which one did the request
  -- use" unanswerable.
  UNIQUE (connection_id, auth_strategy)
);

CREATE INDEX credentials_by_connection ON connection_credentials (connection_id);
/* Finding what is about to expire is the sweeper's whole job. */
CREATE INDEX credentials_expiring ON connection_credentials (expires_at)
  WHERE expires_at IS NOT NULL;

/*
 * ── The OAuth flow in progress ─────────────────────────────────────────────
 *
 * §4.3. The state parameter is BOTH the routing mechanism and the CSRF defence,
 * which is why it is a row rather than a signed cookie: the server has to be
 * able to say which connection, which organisation and which membership started
 * this, and a value it merely echoes back proves none of that.
 *
 * ONLY THE HASH IS STORED. The state travels in a URL, through the provider,
 * and lands in access logs on both sides — treating it as a bearer secret and
 * storing only its digest costs nothing and means a leaked log is not a leaked
 * session.
 *
 * PENDING ROWS EXPIRE AND ARE SWEPT. A provider returning an error rather than
 * a code, and a user closing the tab, both leave one behind.
 */
CREATE TABLE oauth_pending_states (
  state_hash      text        PRIMARY KEY CHECK (length(state_hash) = 64),

  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  /** Who started it. A different person completing the flow is not the same flow. */
  initiated_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  /** PKCE. Held server-side so the browser never has to keep it. */
  code_verifier   text,
  /** What was asked for, so §4.3's scope check has something to compare against. */
  requested_scopes text[]     NOT NULL DEFAULT '{}',

  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz
);

CREATE INDEX oauth_pending_sweep ON oauth_pending_states (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE connection_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_credentials FORCE  ROW LEVEL SECURITY;
ALTER TABLE oauth_pending_states   ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_pending_states   FORCE  ROW LEVEL SECURITY;

/*
 * Credentials reach through their connection rather than carrying their own
 * `organisation_id`. Denormalising would be faster and would create a second
 * answer to which tenant a sealed secret belongs to — and the two would
 * disagree the first time anything moved.
 */
CREATE POLICY connection_credentials_tenant ON connection_credentials
  USING (EXISTS (SELECT 1 FROM connections c
                  WHERE c.id = connection_id AND c.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM connections c
                       WHERE c.id = connection_id AND c.organisation_id = app_org_id()));

CREATE POLICY oauth_pending_states_tenant ON oauth_pending_states
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON connection_credentials, oauth_pending_states TO silo_app;
