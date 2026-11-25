/*
 * 066 — the approval chain, and the storage bound the disclosure states.
 *
 * ── Why the chain is built here ─────────────────────────────────────────────
 *
 * Capture §4: "Purge routes through the approval chain where the organisation
 * has configured one. It is destructive and irreversible, and the machinery
 * exists." The machinery did not exist. Discovery's `approval_id` has been
 * "nullable and unreferenced because approvals are not built" since 019, and
 * `APPROVAL_TTL_HOURS` was a constant nothing read.
 *
 * So this is the machinery, built for the first action that needs it and shaped
 * so the next one is a new value in two CHECKs rather than a new design. An
 * organisation decides which actions need a second person and how many; a
 * request records who asked and for what, by reference only; each decision is
 * its own append-only row.
 */

/* ── Which actions need approval ─────────────────────────────────────────── */

CREATE TABLE approval_policies (
  organisation_id    uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  action             text        NOT NULL CHECK (action IN ('silo.purge')),

  /* More than one is a real choice for a wipe; more than five is a queue nobody
     clears, and an approval nobody can obtain is a purge nobody can make. */
  approvals_required integer     NOT NULL DEFAULT 1 CHECK (approvals_required BETWEEN 1 AND 5),

  configured_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  configured_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organisation_id, action)
);

ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_policies FORCE  ROW LEVEL SECURITY;
CREATE POLICY approval_policies_tenant ON approval_policies
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_policies TO silo_app;

/* ── A request, waiting ──────────────────────────────────────────────────── */

/*
 * `subject` IS REFERENCES, NEVER CONTENT. For a purge: the Silo, the scope, and
 * the concept and entity it names. What those records said is exactly what the
 * purge exists to remove, and a request table holding it would be a copy the
 * purge could not reach.
 *
 * `approvals_required` IS COPIED FROM THE POLICY AT REQUEST TIME. A policy
 * tightened while a request waits applies to the next request, not by silently
 * moving the bar on one already made.
 */
CREATE TABLE approval_requests (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  action             text        NOT NULL CHECK (action IN ('silo.purge')),
  subject            jsonb       NOT NULL,
  approvals_required integer     NOT NULL CHECK (approvals_required BETWEEN 1 AND 5),

  requested_by       uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,

  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  decided_at         timestamptz,
  /* What happened when it ran: a receipt id, or the error code that stopped it. */
  outcome            jsonb,

  CONSTRAINT approval_requests_window CHECK (expires_at > requested_at)
);

CREATE INDEX approval_requests_by_status
  ON approval_requests (organisation_id, status, requested_at DESC);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE  ROW LEVEL SECURITY;
CREATE POLICY approval_requests_tenant ON approval_requests
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON approval_requests TO silo_app;

/* ── Each decision ───────────────────────────────────────────────────────── */

/*
 * APPEND-ONLY, ONE PER PERSON PER REQUEST. No UPDATE or DELETE grant: an
 * approval that can be edited afterwards is not evidence of anything.
 */
CREATE TABLE approval_decisions (
  request_id      uuid        NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  decided_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  decision        text        NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason          text        CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  decided_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (request_id, decided_by),
  CONSTRAINT approval_decisions_reject_has_reason CHECK (decision = 'approve' OR reason IS NOT NULL)
);

ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE  ROW LEVEL SECURITY;
CREATE POLICY approval_decisions_tenant ON approval_decisions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON approval_decisions TO silo_app;

/*
 * THE SECOND PERSON IS A RULE OF THE SCHEMA, NOT ONLY OF THE SERVICE. A check in
 * one service is a check the next caller omits; the person who asked for a
 * destructive action cannot record a decision on it however the row arrives.
 */
CREATE OR REPLACE FUNCTION approval_decided_by_second_person()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM approval_requests r
     WHERE r.id = NEW.request_id AND r.requested_by = NEW.decided_by
  ) THEN
    RAISE EXCEPTION 'The person who asked for this cannot decide it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_decisions_second_person
  BEFORE INSERT ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION approval_decided_by_second_person();

/* ── Who configures it ───────────────────────────────────────────────────── */

/*
 * SUPER ADMIN, NOT SCOPEABLE. Whether a wipe needs a second person is a rule
 * about the organisation, and a rule a scope admin could switch off for the data
 * they want gone would not be a rule.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('approval.configure', 'approval', 'Decide which destructive actions need a second person', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'approval.configure'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;

/* ── The retention bound, as the schema's ─────────────────────────────────── */

/*
 * THE DISCLOSURE SAYS "NEVER LONGER THAN 730 DAYS", AND THE SCHEMA SAID 3650.
 * The API refused anything past 730, but a bound that lives only in a request
 * validator is a promise; the product's claim is that nothing is stored
 * permanently, and the bound behind that claim is a constraint.
 *
 * NO ROW IS SHORTENED TO FIT. Shortening a window destroys data, so a Silo past
 * the new bound makes this migration fail rather than quietly deleting what it
 * held.
 */
ALTER TABLE siloes DROP CONSTRAINT siloes_retention_days_check;
ALTER TABLE siloes ADD CONSTRAINT siloes_retention_days_check
  CHECK (retention_days BETWEEN 1 AND 730);
