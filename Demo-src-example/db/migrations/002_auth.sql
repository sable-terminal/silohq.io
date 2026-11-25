-- 002_auth — sessions, resets, MFA, invitations and the audit trail.
--
-- FOUR OF THESE ARE NOT UNDER ROW LEVEL SECURITY, AND THE REASON IS THE SAME FOR
-- ALL FOUR: they are keyed by user, not by organisation. A session belongs to a
-- person who may act in three tenants; a password reset belongs to a person
-- before any tenant is chosen. There is no `organisation_id` to write a policy
-- against, and inventing one would mean a user with three memberships needs three
-- sessions to check their mail.
--
-- They are reached only through `users`, and the application layer is what
-- constrains them. `auth_events` and `invitations` DO carry an organisation and
-- are therefore under RLS like everything else.

-- ── Sessions ────────────────────────────────────────────────────────────────
--
-- OPAQUE, SERVER-SIDE, NOT A JWT. A signed token carries its own claims, so
-- revoking one means either keeping a denylist — which is a session table with
-- extra steps — or waiting for it to expire. Revocation has to take effect on the
-- next request: a suspended member must lose access now, not in eight hours.
--
-- THE TOKEN IS STORED AS A HASH. Whoever holds a session token is the user, so
-- storing the plaintext makes a database backup a set of live logins.

CREATE TABLE sessions (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Which membership this session is acting as. Null between authenticating and
  -- choosing an organisation — the only moment a session is authenticated and
  -- authorised for nothing.
  active_membership_id  uuid        REFERENCES memberships(id) ON DELETE RESTRICT,

  token_hash            text        NOT NULL UNIQUE,

  issued_at             timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  last_seen_at          timestamptz,

  -- Hashed, never stored raw. See `utils/hash.util.ts`: an unkeyed hash of an
  -- IPv4 address is reversible by exhausting all four billion of them.
  ip_hash               text,
  user_agent_hash       text,

  auth_method           text        NOT NULL
                                    CHECK (auth_method IN ('password', 'sso', 'agent')),

  -- Where the organisation requires MFA, a session without this is authenticated
  -- and authorised for nothing.
  mfa_satisfied_at      timestamptz,

  CONSTRAINT sessions_expire_after_issue CHECK (expires_at > issued_at)
);

-- The hot path: "is this session still valid". Partial, because a revoked or
-- expired session is never the subject of that question.
CREATE INDEX sessions_active ON sessions (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX sessions_by_membership ON sessions (active_membership_id)
  WHERE revoked_at IS NULL;

-- ── Password resets ─────────────────────────────────────────────────────────
--
-- SINGLE USE, AND CONSUMING ONE REVOKES EVERY SESSION FOR THAT USER. A reset is
-- what somebody does when they believe their account is compromised, and leaving
-- the attacker's existing session alive is the one outcome that must not happen.

CREATE TABLE password_resets (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash        text        NOT NULL UNIQUE,
  requested_ip_hash text,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Finds the outstanding reset for a user, so requesting a second one can
-- invalidate the first rather than leaving two live tokens.
CREATE INDEX password_resets_pending ON password_resets (user_id)
  WHERE consumed_at IS NULL;

-- ── Multi-factor ────────────────────────────────────────────────────────────
--
-- THE SECRET IS SEALED UNDER THE SAME ENVELOPE SCHEME AS CONNECTOR CREDENTIALS.
-- A TOTP secret is a bearer credential: anybody holding it can generate valid
-- codes forever. It gets the same treatment as an API key because it is one.

CREATE TABLE mfa_factors (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind            text        NOT NULL CHECK (kind IN ('totp', 'webauthn')),

  -- Sealed bytes, the wrapped data key, and which KEK wrapped it.
  secret_sealed   bytea,
  secret_key_ref  text,

  -- WebAuthn only: the credential id, which is not a secret.
  credential_id   text,

  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- An unconfirmed factor is one somebody started enrolling and abandoned. It
  -- must never satisfy an MFA requirement, so the state is explicit rather than
  -- inferred from whether a secret exists.
  CONSTRAINT mfa_totp_has_secret
    CHECK (kind <> 'totp' OR secret_sealed IS NOT NULL),
  CONSTRAINT mfa_webauthn_has_credential
    CHECK (kind <> 'webauthn' OR credential_id IS NOT NULL)
);

CREATE INDEX mfa_factors_by_user ON mfa_factors (user_id) WHERE confirmed_at IS NOT NULL;

-- ── Invitations ─────────────────────────────────────────────────────────────
--
-- UNDER RLS: an invitation belongs to an organisation.
--
-- THE TOKEN IS HASHED AND THE PLAINTEXT EXISTS ONLY IN THE EMAIL. An invitation
-- token grants membership of a tenant, so it is a credential like any other.

CREATE TABLE invitations (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  email             citext      NOT NULL,
  token_hash        text        NOT NULL UNIQUE,

  -- What the invitee gets on acceptance. Held here rather than applied on send,
  -- so an invitation that is never accepted grants nothing.
  role_id           uuid,
  scope_id          uuid,
  seat_id           uuid,

  invited_by        uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One outstanding invitation per address per organisation. Partial, so a
-- re-invitation after a revocation or acceptance is allowed.
CREATE UNIQUE INDEX invitations_one_pending
  ON invitations (organisation_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ── Finding an invitation before a tenant exists ────────────────────────────
--
-- ACCEPTANCE CANNOT SET A TENANT CONTEXT, BECAUSE THE TOKEN IS WHAT IDENTIFIES
-- THE TENANT. The invitee is not a member of anything yet, so there is no
-- organisation to act as — and `invitations` is under a policy keyed on exactly
-- that. Without this function the lookup returns nothing and no invitation can
-- ever be accepted. Found by the first test that tried.
--
-- `SECURITY DEFINER` IS A HOLE IN ROW LEVEL SECURITY AND IT IS DRILLED AS
-- NARROWLY AS POSSIBLE. It takes a hash and returns at most one row. It cannot
-- list, cannot filter, cannot be asked "what invitations exist" — the only way to
-- get anything out of it is to already hold a token, which is 256 bits from a
-- CSPRNG. Possession of the token IS the authorisation, exactly as it is for a
-- session.
--
-- `search_path` IS PINNED. Without it, a caller can create a schema earlier in
-- their own search path containing a malicious `invitations` table, and this
-- function — running as its owner, who is the migrator — would read it. That is
-- the standard privilege escalation against SECURITY DEFINER and it is one line
-- to close.
CREATE OR REPLACE FUNCTION invitation_by_token(p_token_hash text)
RETURNS TABLE (
  id uuid, organisation_id uuid, email citext, token_hash text,
  role_id uuid, scope_id uuid, seat_id uuid, invited_by uuid,
  expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz,
  created_at timestamptz, organisation_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT i.id, i.organisation_id, i.email, i.token_hash,
         i.role_id, i.scope_id, i.seat_id, i.invited_by,
         i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
         o.name AS organisation_name
    FROM invitations i
    JOIN organisations o ON o.id = i.organisation_id
   WHERE i.token_hash = p_token_hash
   LIMIT 1
$$;

-- Claim an invitation, without a tenant context, atomically.
--
-- THE SINGLE-USE CHECK IS IN THE `WHERE`, so two simultaneous acceptances cannot
-- both succeed. Splitting it into a read here and a write through the ordinary
-- policy would reintroduce the race the repo was written to avoid.
CREATE OR REPLACE FUNCTION claim_invitation(p_token_hash text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE invitations SET accepted_at = now()
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > now()
  RETURNING id
$$;

REVOKE ALL ON FUNCTION invitation_by_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_by_token(text) TO silo_app;
GRANT EXECUTE ON FUNCTION claim_invitation(text) TO silo_app;

-- ── Audit ───────────────────────────────────────────────────────────────────
--
-- APPEND ONLY, AND ENFORCED BY GRANT RATHER THAN BY CONVENTION. The application
-- role gets INSERT and SELECT below and never UPDATE or DELETE. A trail the
-- application can rewrite is not a trail, and the reviewer asking will check the
-- grants rather than read the code.
--
-- `bigserial`, NOT A UUID. This table is append-only and high volume, and a
-- monotonic key means inserts land at the end of the index rather than scattered
-- through it. The id is internal and never appears in a URL, so it leaks nothing.

CREATE TABLE auth_events (
  id                bigserial   PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  -- Null on a failed login, where there is genuinely no membership yet.
  membership_id     uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  user_id           uuid        REFERENCES users(id) ON DELETE RESTRICT,

  event             text        NOT NULL,
  detail            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_hash           text,

  occurred_at       timestamptz NOT NULL DEFAULT now()
);

-- The question a reviewer asks: what happened in this tenant, in this window.
CREATE INDEX auth_events_by_org_time ON auth_events (organisation_id, occurred_at DESC);
-- And: what has this person done.
CREATE INDEX auth_events_by_membership ON auth_events (membership_id, occurred_at DESC)
  WHERE membership_id IS NOT NULL;
-- And: every instance of one event type, for a specific investigation.
CREATE INDEX auth_events_by_event ON auth_events (organisation_id, event, occurred_at DESC);

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_events FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_tenant ON invitations
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY auth_events_tenant ON auth_events
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, password_resets, mfa_factors, invitations TO silo_app;

-- APPEND ONLY. No UPDATE, no DELETE, deliberately and permanently.
GRANT SELECT, INSERT ON auth_events TO silo_app;
GRANT USAGE, SELECT ON SEQUENCE auth_events_id_seq TO silo_app;
