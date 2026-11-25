-- 019_discovery — the agent finding systems nobody told us about.
--
-- OFF BY DEFAULT, AND OFF MEANS UNREACHABLE RATHER THAN IDLE. §9 is compiled
-- out of the sovereign build entirely; here the switch is a row that does not
-- exist until somebody creates it.
--
-- ── The structural guarantee ────────────────────────────────────────────────
--
-- THERE IS NO COLUMN FOR ROW CONTENTS ANYWHERE IN THIS FILE, and that absence is
-- the mechanism. §9.3 says discovery reports structure only — schema, columns,
-- types, foreign keys, row counts — because discovery must not be the phase
-- where the no-data-stored claim quietly breaks. A policy saying "do not store
-- rows" is a policy; a schema with nowhere to put them is a guarantee.

CREATE TABLE discovery_settings (
  organisation_id uuid        PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,

  enabled         boolean     NOT NULL DEFAULT false,
  /*
   * §9.1: `discovery.manage`, super admin only, NOT delegable to a scope admin —
   * on the same reasoning as clearance. A subordinate admin must not authorise
   * scanning of a network they administer only part of.
   */
  enabled_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  enabled_at      timestamptz,
  disabled_by     uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  disabled_at     timestamptz,

  CONSTRAINT discovery_enabled_attributed CHECK (enabled = false OR enabled_by IS NOT NULL)
);

/*
 * ── One authorisation per scan ─────────────────────────────────────────────
 *
 * ENABLING THE SWITCH AUTHORISES NOTHING. Each scan carries its own record, its
 * own ranges, its own expiry. A window, never standing permission — a recurring
 * scan is its own configuration with its own approval.
 */
CREATE TABLE discovery_authorisations (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * Text rather than a foreign key: the agent subsystem is not built. It becomes
   * an FK when it is, and naming that here is better than a uuid pointing at
   * nothing and looking like it points at something.
   */
  agent_id        text        NOT NULL CHECK (length(trim(agent_id)) BETWEEN 1 AND 128),

  /*
   * EXPLICIT, WITH NO DEFAULT AND NO INFERENCE. §9.2: no default of the local
   * subnet, no inference from the agent's own address. `cidr[]` rather than text
   * so a malformed range is refused by the type rather than by a regex somebody
   * has to remember to write.
   */
  ranges          cidr[]      NOT NULL CHECK (cardinality(ranges) > 0),

  /*
   * SEPARATELY SELECTABLE, because a customer permitting catalogue introspection
   * and refusing a port scan is normal — and the reverse would be a surprise
   * they did not agree to.
   */
  methods         text[]      NOT NULL CHECK (
                    cardinality(methods) > 0
                    AND methods <@ ARRAY['port_scan', 'read_host_config', 'catalogue_introspect']),

  authorised_by   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  authorised_at   timestamptz NOT NULL DEFAULT now(),

  /*
   * §9.2 routes a scan through the approval chain — it touches systems outside
   * Silo and is closer to a mutation than a query. Nullable and unreferenced
   * because approvals are not built; it becomes an FK when they are, and the
   * service refuses to create an authorisation without one at that point.
   */
  approval_id     uuid,

  expires_at      timestamptz NOT NULL,
  revoked_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  revoked_at      timestamptz,

  CONSTRAINT discovery_auth_window CHECK (expires_at > authorised_at),
  CONSTRAINT discovery_auth_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX discovery_auth_live ON discovery_authorisations (organisation_id)
  WHERE revoked_at IS NULL;

/*
 * AN AUTHORISATION CANNOT EXIST WHILE DISCOVERY IS OFF. Off means unreachable,
 * not idle — and a row created while the switch was on that outlives it being
 * turned off would be exactly the standing permission §9.2 refuses.
 */
CREATE OR REPLACE FUNCTION discovery_requires_enabled() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM discovery_settings s
     WHERE s.organisation_id = NEW.organisation_id AND s.enabled
  ) THEN
    RAISE EXCEPTION 'Discovery is not enabled for this organisation.'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER discovery_auth_needs_enabled
  BEFORE INSERT ON discovery_authorisations
  FOR EACH ROW EXECUTE FUNCTION discovery_requires_enabled();

CREATE TABLE discovery_runs (
  id               uuid        PRIMARY KEY,
  authorisation_id uuid        NOT NULL REFERENCES discovery_authorisations(id) ON DELETE RESTRICT,

  status           text        NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
  hosts_contacted  integer     NOT NULL DEFAULT 0 CHECK (hosts_contacted >= 0),

  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  CONSTRAINT discovery_run_finished CHECK (status = 'running' OR completed_at IS NOT NULL)
);

CREATE INDEX discovery_runs_by_auth ON discovery_runs (authorisation_id, started_at DESC);

/*
 * A RUN CANNOT START WITHOUT A LIVE AUTHORISATION. Checked in the database
 * because the window is the entire control: an expired authorisation that still
 * permits a scan is standing permission with extra steps.
 */
CREATE OR REPLACE FUNCTION discovery_run_needs_live_authorisation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ok boolean;
BEGIN
  SELECT (a.revoked_at IS NULL AND a.expires_at > now())
    INTO ok
    FROM discovery_authorisations a
   WHERE a.id = NEW.authorisation_id;

  IF NOT COALESCE(ok, false) THEN
    RAISE EXCEPTION 'That scan authorisation has expired or been revoked.'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER discovery_run_authorised
  BEFORE INSERT ON discovery_runs
  FOR EACH ROW EXECUTE FUNCTION discovery_run_needs_live_authorisation();

CREATE TABLE discovery_findings (
  id            uuid        PRIMARY KEY,
  run_id        uuid        NOT NULL REFERENCES discovery_runs(id) ON DELETE RESTRICT,

  host          text        NOT NULL CHECK (length(trim(host)) BETWEEN 1 AND 256),
  port          integer     CHECK (port IS NULL OR port BETWEEN 1 AND 65535),

  /*
   * STRUCTURE ONLY. Schema, columns, types, foreign keys, row counts, endpoint
   * shapes. There is no column here for a value read out of the customer's data
   * and there must never be one — this is where the no-data-stored claim would
   * break, and it would break quietly.
   */
  structure     jsonb       NOT NULL DEFAULT '{}',

  /** What it appears to be, which is a guess until somebody confirms it. */
  proposed_transport text   REFERENCES connector_transports(kind),
  confidence    numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),

  /*
   * A PROPOSAL, NEVER A CONFIGURATION. An admin approves items individually, and
   * approval creates a private-tier connection that then runs the same
   * verification as anything else. Finding a Postgres instance is not access to
   * it — credentials are still supplied through the normal path.
   */
  decision      text        CHECK (decision IS NULL OR decision IN ('accepted', 'rejected', 'ignored')),
  reviewed_by   uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  reviewed_at   timestamptz,
  promoted_connection_id uuid REFERENCES connections(id) ON DELETE RESTRICT,

  found_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT discovery_finding_reviewed_pair CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
  -- A promotion is the consequence of accepting, so it cannot precede one.
  CONSTRAINT discovery_finding_promotion_accepted CHECK (
    promoted_connection_id IS NULL OR decision = 'accepted'
  )
);

CREATE INDEX discovery_findings_by_run ON discovery_findings (run_id);
CREATE INDEX discovery_findings_unreviewed ON discovery_findings (run_id) WHERE reviewed_at IS NULL;

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE discovery_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_settings       FORCE  ROW LEVEL SECURITY;
ALTER TABLE discovery_authorisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_authorisations FORCE  ROW LEVEL SECURITY;
ALTER TABLE discovery_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_runs           FORCE  ROW LEVEL SECURITY;
ALTER TABLE discovery_findings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_findings       FORCE  ROW LEVEL SECURITY;

CREATE POLICY discovery_settings_tenant ON discovery_settings
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

CREATE POLICY discovery_authorisations_tenant ON discovery_authorisations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* Runs and findings reach through the authorisation, which carries the tenant. */
CREATE POLICY discovery_runs_tenant ON discovery_runs
  USING (EXISTS (SELECT 1 FROM discovery_authorisations a
                  WHERE a.id = authorisation_id AND a.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM discovery_authorisations a
                       WHERE a.id = authorisation_id AND a.organisation_id = app_org_id()));

CREATE POLICY discovery_findings_tenant ON discovery_findings
  USING (EXISTS (SELECT 1 FROM discovery_runs r
                  JOIN discovery_authorisations a ON a.id = r.authorisation_id
                 WHERE r.id = run_id AND a.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM discovery_runs r
                       JOIN discovery_authorisations a ON a.id = r.authorisation_id
                      WHERE r.id = run_id AND a.organisation_id = app_org_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  discovery_settings, discovery_authorisations, discovery_runs, discovery_findings TO silo_app;
