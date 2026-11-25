/*
 * 074 — who must agree to a change, and the record of each person who did.
 *
 * ── Policy is per connection ───────────────────────────────────────────────
 *
 * Mutations §9: "Policy is per connection, configurable, resolved most specific
 * first: connection plus scope, then connection, then organisation default. A
 * connection with no policy requires one approver holding mutation.approve on
 * it." The purge chain in 066 is one rule per organisation per action; a write
 * to the finance ledger and a write to the support desk are not the same risk,
 * so they are not the same rule.
 *
 * ── Floors ─────────────────────────────────────────────────────────────────
 *
 * §14: "mutation.policy sits with the connection's policy authority: owner set,
 * delegated, or locked by a super admin, with floors that a delegated admin may
 * make stricter and never weaker." `connections.policy_authority` has existed
 * since 014 and nothing read it; this is what it governs. A floor is a super
 * admin's minimum for one connection, and a policy configured beneath it is
 * overridden by it rather than trusted.
 *
 * ── The chain is a snapshot ────────────────────────────────────────────────
 *
 * §9: "The resolved policy is snapshotted onto the chain at creation. A policy
 * changed mid-flight does not alter a pending approval." A trigger holds the
 * snapshot still, so the abuse it prevents cannot arrive through an UPDATE.
 */

/* ── Who may set policy on a connection ──────────────────────────────────── */

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('mutation.policy', 'mutation', 'Set who must approve changes made through a connection', true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'mutation.policy'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;

/* ── Policies ────────────────────────────────────────────────────────────── */

/*
 * ONE ROW PER VERSION. A replaced policy is superseded rather than updated, so
 * which rule a past chain was resolved from can be read back, and the snapshot
 * on the chain names the row it came from.
 *
 * THE LEVEL IS THE SHAPE OF THE ROW. No connection: the organisation default.
 * A connection: that connection. A connection and a scope: that connection, for
 * changes proposed by people in that scope. A scope without a connection means
 * nothing and is refused.
 *
 * `expires_after_hours` NEVER PAST 24. A preview lapses 24 hours after it was
 * read (073), and the disclosure says so; a chain may be shorter, never longer.
 */
CREATE TABLE mutation_policies (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id       uuid        REFERENCES connections(id) ON DELETE RESTRICT,
  scope_id            uuid        REFERENCES scopes(id) ON DELETE RESTRICT,
  approvals_required  integer     NOT NULL CHECK (approvals_required BETWEEN 1 AND 5),
  required_role_id    uuid        REFERENCES roles(id) ON DELETE RESTRICT,
  allow_self_approval boolean     NOT NULL DEFAULT false,
  separate_execution  boolean     NOT NULL DEFAULT false,
  expires_after_hours integer     NOT NULL DEFAULT 24 CHECK (expires_after_hours BETWEEN 1 AND 24),
  set_by              uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  set_at              timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz,
  CONSTRAINT mutation_policies_scope_needs_connection CHECK (scope_id IS NULL OR connection_id IS NOT NULL)
);

CREATE UNIQUE INDEX mutation_policies_live
  ON mutation_policies (
    organisation_id,
    COALESCE(connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE superseded_at IS NULL;

ALTER TABLE mutation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_policies FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_policies_tenant ON mutation_policies
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* UPDATE only to mark a version superseded; nothing is deleted. */
GRANT SELECT, INSERT, UPDATE ON mutation_policies TO silo_app;

/* ── Floors ──────────────────────────────────────────────────────────────── */

/*
 * THE SAME TERMS AS A POLICY, READ AS MINIMUMS. More approvals, a required
 * role, self-approval forbidden, execution separated, a shorter window: each is
 * stricter, and a resolved policy takes whichever of the two is.
 */
CREATE TABLE mutation_policy_floors (
  connection_id       uuid        PRIMARY KEY REFERENCES connections(id) ON DELETE RESTRICT,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  approvals_required  integer     NOT NULL CHECK (approvals_required BETWEEN 1 AND 5),
  required_role_id    uuid        REFERENCES roles(id) ON DELETE RESTRICT,
  allow_self_approval boolean     NOT NULL DEFAULT false,
  separate_execution  boolean     NOT NULL DEFAULT false,
  expires_after_hours integer     NOT NULL DEFAULT 24 CHECK (expires_after_hours BETWEEN 1 AND 24),
  set_by              uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  set_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mutation_policy_floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_policy_floors FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_policy_floors_tenant ON mutation_policy_floors
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON mutation_policy_floors TO silo_app;

/* ── A change awaiting approval ──────────────────────────────────────────── */

ALTER TABLE mutations DROP CONSTRAINT mutations_status_check;
ALTER TABLE mutations ADD CONSTRAINT mutations_status_check
  CHECK (status IN ('previewed', 'awaiting_approval', 'approved', 'rejected'));

/*
 * `policy` IS THE RESOLVED UNION, AS IT STOOD WHEN APPROVAL WAS ASKED FOR. Which
 * policy each connection resolved to and at what level, whether a floor
 * overrode it, the bulk tier's additional approval, and the terms the chain is
 * held to. Nothing else decides whether the chain is satisfied.
 *
 * SIX, NOT FIVE. A policy asks for at most five; a bulk change adds one (§8).
 */
CREATE TABLE mutation_chains (
  id                  uuid        PRIMARY KEY,
  mutation_id         uuid        NOT NULL UNIQUE REFERENCES mutations(id) ON DELETE CASCADE,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  policy              jsonb       NOT NULL,
  approvals_required  integer     NOT NULL CHECK (approvals_required BETWEEN 1 AND 6),
  approvals_received  integer     NOT NULL DEFAULT 0 CHECK (approvals_received >= 0),
  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  decided_at          timestamptz,
  /* Counted from when the preview was read, which is before the chain exists, so
     never more than a day past the chain either. */
  CONSTRAINT mutation_chains_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '24 hours'
  )
);

CREATE INDEX mutation_chains_by_status ON mutation_chains (organisation_id, status, expires_at);

ALTER TABLE mutation_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_chains FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_chains_tenant ON mutation_chains
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON mutation_chains TO silo_app;

CREATE OR REPLACE FUNCTION mutation_chains_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id                 IS DISTINCT FROM OLD.id
  OR NEW.mutation_id        IS DISTINCT FROM OLD.mutation_id
  OR NEW.organisation_id    IS DISTINCT FROM OLD.organisation_id
  OR NEW.policy             IS DISTINCT FROM OLD.policy
  OR NEW.approvals_required IS DISTINCT FROM OLD.approvals_required
  OR NEW.created_at         IS DISTINCT FROM OLD.created_at
  OR NEW.expires_at         IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'An approval chain is resolved once; a policy changed later does not reach it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mutation_chains_snapshot
  BEFORE UPDATE ON mutation_chains
  FOR EACH ROW EXECUTE FUNCTION mutation_chains_snapshot();

/* ── Each decision ───────────────────────────────────────────────────────── */

/*
 * UNIQUE ON CHAIN PLUS APPROVER (§9), so one person cannot satisfy two required
 * approvals however many times the request arrives.
 *
 * `self_approval` IS SET BY THE DATABASE, NOT BY THE CALLER. "Recorded distinctly
 * rather than as an ordinary approval, because a reviewer will ask how many
 * changes were self-approved and the answer must be countable" — countable from
 * a column no service can get wrong, and refused outright where the chain's
 * snapshot does not allow it.
 *
 * `role_ids` ARE THE ROLES THE APPROVER HELD WHEN THEY DECIDED. A role requirement
 * is satisfied by who the approver was, and revoking a role afterwards does not
 * rewrite whether it was.
 *
 * APPEND-ONLY. No UPDATE or DELETE grant.
 */
CREATE TABLE mutation_approvals (
  chain_id        uuid        NOT NULL REFERENCES mutation_chains(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  sequence        integer     NOT NULL CHECK (sequence >= 1),
  approver        uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  decision        text        NOT NULL CHECK (decision IN ('approve', 'reject')),
  self_approval   boolean     NOT NULL DEFAULT false,
  role_ids        uuid[]      NOT NULL DEFAULT '{}',
  comment         text        CHECK (comment IS NULL OR length(trim(comment)) BETWEEN 1 AND 1000),
  decided_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, approver),
  UNIQUE (chain_id, sequence),
  CONSTRAINT mutation_approvals_reject_has_comment CHECK (decision = 'approve' OR comment IS NOT NULL)
);

ALTER TABLE mutation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_approvals FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_approvals_tenant ON mutation_approvals
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT ON mutation_approvals TO silo_app;

CREATE OR REPLACE FUNCTION mutation_approvals_self()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  proposer uuid;
  allowed  boolean;
BEGIN
  SELECT m.proposed_by, COALESCE((c.policy ->> 'allowSelfApproval')::boolean, false)
    INTO proposer, allowed
    FROM mutation_chains c
    JOIN mutations m ON m.id = c.mutation_id
   WHERE c.id = NEW.chain_id;

  NEW.self_approval := (NEW.approver = proposer);

  IF NEW.self_approval AND NEW.decision = 'approve' AND NOT allowed THEN
    RAISE EXCEPTION 'The person who proposed this change cannot approve it'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER mutation_approvals_self
  BEFORE INSERT ON mutation_approvals
  FOR EACH ROW EXECUTE FUNCTION mutation_approvals_self();
