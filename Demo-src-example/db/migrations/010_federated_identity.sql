-- 010_federated_identity — signing in with somebody else's directory.
--
-- OIDC, AND DELIBERATELY NOT SAML.
--
-- SAML's security rests on verifying an XML signature, which means canonicalising
-- a document and checking a signature over a subset of it that the document
-- itself names. Getting that subtly wrong produces signature-wrapping attacks —
-- a class of complete authentication bypass that has repeatedly shipped in
-- libraries written by people who do this full time. It is not a thing to
-- hand-roll, and there is no vetted implementation in this dependency set. OIDC
-- verifies a compact JWS over bytes that are already unambiguous, which Node's
-- own crypto does correctly.
--
-- OIDC also covers Google Workspace, Microsoft Entra, Okta and Auth0, which is
-- very nearly everyone who asks for SSO. If an enterprise deal genuinely needs
-- SAML, the answer is a reviewed library, not this file growing an XML parser.
--
-- ── What is stored, and what is not ─────────────────────────────────────────
--
-- THE CLIENT SECRET IS SEALED, not stored. It is a credential that lets anybody
-- holding it impersonate this Silo tenant to the customer's identity provider,
-- so it gets the same envelope encryption as a connector credential — a fresh
-- data key per row, wrapped by the KEK in KMS, bound to the row it belongs to.
--
-- THE SUBJECT IS THE JOIN, NOT THE EMAIL. A directory's `sub` claim is stable
-- and an email address is not: people get married, companies rename domains, and
-- an alias is reassigned to a new joiner. Keying the link on email means the
-- second person to hold `finance@` inherits the first person's account.

CREATE TABLE identity_providers (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  kind                text        NOT NULL DEFAULT 'oidc' CHECK (kind = 'oidc'),
  name                text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /*
   * The provider's own identifier, and the value every `iss` claim must equal.
   * Checking it is what stops a token minted by a different directory — one the
   * attacker controls — being accepted as this one.
   */
  issuer              text        NOT NULL,
  authorization_endpoint text     NOT NULL,
  token_endpoint      text        NOT NULL,
  jwks_uri            text        NOT NULL,

  client_id           text        NOT NULL,
  client_secret_sealed bytea      NOT NULL,
  client_secret_key   text        NOT NULL,
  client_secret_wrapped bytea     NOT NULL,

  enabled             boolean     NOT NULL DEFAULT true,
  created_by          uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, name)
);

/*
 * ── Which addresses a provider may assert ──────────────────────────────────
 *
 * A TABLE RATHER THAN AN ARRAY COLUMN, because the constraint that matters is
 * global. Without a domain list at all, a customer who configures their own
 * provider can mint a token for any address they like — including one belonging
 * to a member of a different organisation — and be linked to that person's
 * account. The list is what binds "this directory" to "these people".
 *
 * ONE PROVIDER PER DOMAIN ACROSS THE WHOLE INSTALLATION, and that is the reason
 * this is not an array. Two organisations both claiming `acme.com` is not a
 * conflict to resolve at sign-in time — it is one tenant able to intercept the
 * other's people — and a unique index over an array's elements is not a thing
 * Postgres will do. As its own table the domain IS the primary key, so the
 * second claim is refused at write time, which turns a security question into a
 * support conversation.
 *
 * `citext` because domains are case-insensitive, and because doing it in the
 * type is one place rather than at every call site that forgets.
 */
CREATE TABLE identity_provider_domains (
  domain      citext      PRIMARY KEY CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  provider_id uuid        NOT NULL REFERENCES identity_providers(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX identity_provider_domains_by_provider ON identity_provider_domains (provider_id);

CREATE TABLE federated_identities (
  id            uuid        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id   uuid        NOT NULL REFERENCES identity_providers(id) ON DELETE RESTRICT,

  /** The provider's `sub`. Stable across renames; an email is not. */
  subject       text        NOT NULL,
  /** What the directory last told us, for display and for support questions. */
  last_email    text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider_id, subject)
);

CREATE INDEX federated_identities_by_user ON federated_identities (user_id);

/*
 * ── The in-flight authentication ───────────────────────────────────────────
 *
 * STATE LIVES SERVER-SIDE, NOT IN A COOKIE. A state parameter the server does
 * not remember is a state parameter the server cannot check: it can confirm the
 * value came back unchanged and nothing else. Holding the row here means the
 * nonce, the PKCE verifier and the provider are all bound to one attempt, and
 * the attempt can be consumed exactly once.
 *
 * SINGLE-USE, VIA `consumed_at` IN THE SAME UPDATE THAT READS IT. A replayed
 * callback must not mint a second session.
 */
CREATE TABLE sso_attempts (
  state          text        PRIMARY KEY,
  provider_id    uuid        NOT NULL REFERENCES identity_providers(id) ON DELETE RESTRICT,
  nonce          text        NOT NULL,
  code_verifier  text        NOT NULL,
  /** Where to send them afterwards. Validated as a local path before storing. */
  return_to      text,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sso_attempts_expiry ON sso_attempts (expires_at) WHERE consumed_at IS NULL;

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE identity_providers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_providers   FORCE  ROW LEVEL SECURITY;
ALTER TABLE federated_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE federated_identities FORCE  ROW LEVEL SECURITY;

CREATE POLICY identity_providers_tenant ON identity_providers
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY federated_identities_own ON federated_identities
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

/*
 * `sso_attempts` HAS NO POLICY AND NO TENANT, deliberately. An attempt is
 * created before anybody is identified — that is what it is for — and it holds
 * no data about a person: a random state, a random nonce, a random verifier and
 * a provider id. Row level security on it would have nothing to key on and would
 * only make the flow impossible.
 */

-- ── The lookups that happen before anybody is signed in ─────────────────────

/*
 * Finding the provider for an address, with no tenant and no session. This is
 * the step that decides which organisation a person is even trying to reach.
 */
CREATE OR REPLACE FUNCTION identity_provider_for_domain(p_domain text)
RETURNS TABLE (
  id uuid, organisation_id uuid, issuer text, authorization_endpoint text,
  token_endpoint text, jwks_uri text, client_id text,
  client_secret_sealed bytea, client_secret_key text, client_secret_wrapped bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.organisation_id, p.issuer, p.authorization_endpoint,
         p.token_endpoint, p.jwks_uri, p.client_id,
         p.client_secret_sealed, p.client_secret_key, p.client_secret_wrapped
    FROM identity_providers p
    JOIN identity_provider_domains d ON d.provider_id = p.id
   WHERE p.enabled AND d.domain = p_domain::citext
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION identity_provider_by_id(p_id uuid)
RETURNS TABLE (
  id uuid, organisation_id uuid, issuer text, authorization_endpoint text,
  token_endpoint text, jwks_uri text, client_id text,
  client_secret_sealed bytea, client_secret_key text, client_secret_wrapped bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.organisation_id, p.issuer, p.authorization_endpoint,
         p.token_endpoint, p.jwks_uri, p.client_id,
         p.client_secret_sealed, p.client_secret_key, p.client_secret_wrapped
    FROM identity_providers p
   WHERE p.id = p_id AND p.enabled
   LIMIT 1;
$$;

/*
 * Consuming an attempt: the check and the mark in one statement, for the same
 * reason `consume_password_reset` is. A replayed callback must not be able to
 * mint a second session by racing the first.
 */
CREATE OR REPLACE FUNCTION consume_sso_attempt(p_state text)
RETURNS TABLE (provider_id uuid, nonce text, code_verifier text, return_to text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE sso_attempts SET consumed_at = now()
   WHERE state = p_state AND consumed_at IS NULL AND expires_at > now()
  RETURNING provider_id, nonce, code_verifier, return_to;
$$;

CREATE OR REPLACE FUNCTION create_sso_attempt(
  p_state text, p_provider_id uuid, p_nonce text, p_code_verifier text,
  p_return_to text, p_expires_at timestamptz
) RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO sso_attempts (state, provider_id, nonce, code_verifier, return_to, expires_at)
  VALUES (p_state, p_provider_id, p_nonce, p_code_verifier, p_return_to, p_expires_at);
$$;

/*
 * Linking a directory subject to a Silo user, before that user has a session.
 * The caller has already verified the id token and checked the domain.
 */
CREATE OR REPLACE FUNCTION link_federated_identity(
  p_id uuid, p_user_id uuid, p_provider_id uuid, p_subject text, p_email text
) RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO federated_identities (id, user_id, provider_id, subject, last_email, last_seen_at)
  VALUES (p_id, p_user_id, p_provider_id, p_subject, p_email, now())
  ON CONFLICT (provider_id, subject)
  DO UPDATE SET last_email = EXCLUDED.last_email, last_seen_at = now();
$$;

CREATE OR REPLACE FUNCTION user_for_federated_subject(p_provider_id uuid, p_subject text)
RETURNS SETOF users
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.* FROM users u
    JOIN federated_identities f ON f.user_id = u.id
   WHERE f.provider_id = p_provider_id AND f.subject = p_subject
   LIMIT 1;
$$;

ALTER TABLE identity_provider_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_provider_domains FORCE  ROW LEVEL SECURITY;

CREATE POLICY identity_provider_domains_tenant ON identity_provider_domains
  USING (EXISTS (SELECT 1 FROM identity_providers p
                  WHERE p.id = provider_id AND p.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM identity_providers p
                       WHERE p.id = provider_id AND p.organisation_id = app_org_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  identity_providers, identity_provider_domains, federated_identities TO silo_app;
GRANT SELECT, INSERT, UPDATE ON sso_attempts TO silo_app;
GRANT EXECUTE ON FUNCTION identity_provider_for_domain(text)      TO silo_app;
GRANT EXECUTE ON FUNCTION identity_provider_by_id(uuid)           TO silo_app;
GRANT EXECUTE ON FUNCTION consume_sso_attempt(text)               TO silo_app;
GRANT EXECUTE ON FUNCTION create_sso_attempt(text, uuid, text, text, text, timestamptz) TO silo_app;
GRANT EXECUTE ON FUNCTION link_federated_identity(uuid, uuid, uuid, text, text) TO silo_app;
GRANT EXECUTE ON FUNCTION user_for_federated_subject(uuid, text)  TO silo_app;
