/*
 * 123 — the Silo agent: a process in the customer's network that reaches what
 * Silo cannot (MANIFEST-V2 §3.4, §9.2).
 *
 * ── An agent is enrolled once and identified by a token ever after ─────────
 *
 * An admin creates an agent and is shown an enrolment token once. The agent
 * exchanges it — with the public half of a keypair it generated itself — for
 * a long-lived token. Both are stored as hashes; the last four characters are
 * kept in clear so a person can tell two agents apart. Job frames are sealed to
 * the agent's public key before they leave the instance that made them, so
 * Redis and every other instance only ever carry ciphertext.
 *
 * ── Which addresses an agent may reach, per connection ────────────────────
 *
 * The manifest names no address inside anybody's network; it says
 * `via: { agent: true }` and nothing else. What the agent may contact for THIS
 * connection is confirmed by the organisation's admin and written here — a host
 * or a `*.` pattern, and a port or a range. The agent keeps its own list as
 * well and takes the intersection, so neither side alone can widen it.
 *
 * ── Three organisations that must be one ──────────────────────────────────
 *
 * A confirmed host names a connection and an agent. A foreign key proves each
 * exists, not that they belong to the same organisation as the row; the trigger
 * below does, so no insert can point one organisation's connection at another's
 * agent.
 */

CREATE TABLE agents (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  name                  text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enrolment_hash        text        UNIQUE,
  enrolment_expires_at  timestamptz,
  token_hash            text        UNIQUE,
  last_four             text        CHECK (last_four IS NULL OR length(last_four) = 4),
  public_key            text        CHECK (public_key IS NULL OR length(public_key) BETWEEN 40 AND 200),
  version               text        CHECK (version IS NULL OR length(version) <= 64),
  hostname              text        CHECK (hostname IS NULL OR length(hostname) <= 255),
  last_seen_at          timestamptz,
  created_by            uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  enrolled_at           timestamptz,
  revoked_by            uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  revoked_at            timestamptz,
  CONSTRAINT agents_enrolment CHECK (
    (enrolled_at IS NULL AND token_hash IS NULL AND public_key IS NULL)
    OR (enrolled_at IS NOT NULL AND token_hash IS NOT NULL AND public_key IS NOT NULL AND enrolment_hash IS NULL)
  ),
  CONSTRAINT agents_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX agents_live ON agents (organisation_id) WHERE revoked_at IS NULL;

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE  ROW LEVEL SECURITY;
CREATE POLICY agents_tenant ON agents
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* Revoked, never deleted: which agent reached what, and until when, is evidence. */
GRANT SELECT, INSERT, UPDATE ON agents TO silo_app;

ALTER TABLE connections ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT;

CREATE TABLE connection_agent_hosts (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  agent_id        uuid        NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  /* A name or an address, or `*.` and a suffix for every host beneath one. */
  host            text        NOT NULL CHECK (host ~ '^(\*\.)?[A-Za-z0-9._:\[\]-]{1,253}$'),
  port_from       integer     NOT NULL CHECK (port_from BETWEEN 1 AND 65535),
  port_to         integer     NOT NULL CHECK (port_to BETWEEN 1 AND 65535 AND port_to >= port_from),
  confirmed_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, agent_id, host, port_from, port_to)
);

CREATE INDEX connection_agent_hosts_agent ON connection_agent_hosts (agent_id);

CREATE FUNCTION connection_agent_hosts_one_organisation() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.organisation_id = NEW.organisation_id)
     OR NOT EXISTS (SELECT 1 FROM connections c WHERE c.id = NEW.connection_id AND c.organisation_id = NEW.organisation_id) THEN
    RAISE EXCEPTION 'A confirmed host, its connection and its agent must belong to one organisation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER connection_agent_hosts_one_organisation
  BEFORE INSERT OR UPDATE ON connection_agent_hosts
  FOR EACH ROW EXECUTE FUNCTION connection_agent_hosts_one_organisation();

ALTER TABLE connection_agent_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_agent_hosts FORCE  ROW LEVEL SECURITY;
CREATE POLICY connection_agent_hosts_tenant ON connection_agent_hosts
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* Replaced when an admin re-confirms, so rows are deleted as well as added. */
GRANT SELECT, INSERT, DELETE ON connection_agent_hosts TO silo_app;

/*
 * ── The two lookups that happen before any organisation is known ─────────
 *
 * SECURITY DEFINER, like `connection_by_intake_token` and for the same reason:
 * the token is what says which organisation this is. Each takes a hash and
 * returns one row or none; neither returns a key, a token or a credential.
 */
CREATE FUNCTION agent_by_token(p_token_hash text)
RETURNS TABLE (id uuid, organisation_id uuid, name text, public_key text) AS $$
  SELECT a.id, a.organisation_id, a.name, a.public_key
    FROM agents a
   WHERE a.token_hash = p_token_hash
     AND a.revoked_at IS NULL
   LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

/* Single use: the enrolment hash is cleared in the same statement that reads it. */
CREATE FUNCTION enrol_agent(p_enrolment_hash text, p_token_hash text, p_last_four text, p_public_key text, p_version text, p_hostname text)
RETURNS TABLE (id uuid, organisation_id uuid, name text) AS $$
  UPDATE agents a
     SET enrolment_hash = NULL,
         enrolment_expires_at = NULL,
         token_hash = p_token_hash,
         last_four = p_last_four,
         public_key = p_public_key,
         version = p_version,
         hostname = p_hostname,
         enrolled_at = now(),
         last_seen_at = now()
   WHERE a.enrolment_hash = p_enrolment_hash
     AND a.enrolment_expires_at > now()
     AND a.revoked_at IS NULL
     AND a.enrolled_at IS NULL
  RETURNING a.id, a.organisation_id, a.name;
$$ LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION agent_by_token(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enrol_agent(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_by_token(text) TO silo_app;
GRANT EXECUTE ON FUNCTION enrol_agent(text, text, text, text, text, text) TO silo_app;

/*
 * SUPER ADMIN, NOT SCOPEABLE. An agent reaches into the organisation's own
 * network on behalf of every connection that uses it; creating one is an
 * organisation-wide act, like deciding a field policy.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('agent.manage', 'connection', 'Install and revoke Silo agents, and confirm what they may reach', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'agent.manage'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
