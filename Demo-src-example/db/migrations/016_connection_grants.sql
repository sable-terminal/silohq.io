-- 016_connection_grants — who may use a connection. Default deny.
--
-- ABSENCE OF A ROW IS DENIAL, and that is the whole design. A connection is
-- reachable by nobody until somebody is granted it, so a forgotten grant is a
-- person who cannot query rather than a system everybody can read.
--
-- THREE KINDS OF GRANTEE, EXACTLY ONE PER ROW. A person, everybody in a scope,
-- or a machine identity. A single nullable-column-per-kind with no constraint is
-- how a row ends up naming two grantees and the engine picks whichever it
-- happens to check first.

CREATE TABLE connection_grants (
  id            uuid        PRIMARY KEY,
  connection_id uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,

  membership_id uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  scope_id      uuid        REFERENCES scopes(id) ON DELETE RESTRICT,
  principal_id  uuid        REFERENCES service_principals(id) ON DELETE RESTRICT,

  /*
   * WHAT THE GRANT PERMITS. Reading and writing are separate because a
   * connection with writes enabled does not mean everybody granted it may write
   * — §7 turns writes on for the CONNECTION, and this says who may use them.
   */
  can_read      boolean     NOT NULL DEFAULT true,
  can_write     boolean     NOT NULL DEFAULT false,

  /*
   * A SCOPE GRANT REACHING ITS DESCENDANTS IS THE COMMON CASE AND THE DANGEROUS
   * ONE. Granting Engineering usually means Engineering and everything under it;
   * sometimes it means Engineering alone.
   *
   * DEFAULTS FALSE AND THE SERVICE ASKS. A default of true means the widest
   * reading is what you get by forgetting, which is the wrong direction for a
   * flag that decides how far an access grant travels.
   */
  include_descendants boolean NOT NULL DEFAULT false,

  /*
   * PROVENANCE, the same shape `role_assignments` uses. `granted_at_scope_id`
   * records the authority the granter was acting under, which is what makes
   * revocation answerable later: an admin may revoke what was granted beneath
   * their own subtree and not what a peer granted beneath theirs.
   */
  granted_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  granted_at_scope_id uuid  REFERENCES scopes(id) ON DELETE RESTRICT,
  granted_at    timestamptz NOT NULL DEFAULT now(),

  expires_at    timestamptz,
  revoked_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  revoked_at    timestamptz,

  CONSTRAINT connection_grants_one_grantee CHECK (
    (membership_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int + (principal_id IS NOT NULL)::int = 1
  ),

  /*
   * `include_descendants` MEANS NOTHING WITHOUT A SUBTREE TO DESCEND. The first
   * version of this also accepted a membership or a principal, which made it
   * true for every row and meant it fired before `one_grantee` — so a grant
   * naming nobody was rejected with a message about descendants.
   */
  CONSTRAINT connection_grants_descendants_need_scope CHECK (
    include_descendants = false OR scope_id IS NOT NULL
  ),

  CONSTRAINT connection_grants_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

/*
 * Partial uniques rather than one over three nullable columns, for the same
 * reason the manifest versions needed two: SQL treats NULLs as distinct, so a
 * plain UNIQUE would constrain nothing.
 */
CREATE UNIQUE INDEX connection_grants_one_per_member
  ON connection_grants (connection_id, membership_id)
  WHERE membership_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX connection_grants_one_per_scope
  ON connection_grants (connection_id, scope_id)
  WHERE scope_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX connection_grants_one_per_principal
  ON connection_grants (connection_id, principal_id)
  WHERE principal_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX connection_grants_live ON connection_grants (connection_id) WHERE revoked_at IS NULL;

ALTER TABLE connection_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_grants FORCE  ROW LEVEL SECURITY;

CREATE POLICY connection_grants_tenant ON connection_grants
  USING (EXISTS (SELECT 1 FROM connections c
                  WHERE c.id = connection_id AND c.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM connections c
                       WHERE c.id = connection_id AND c.organisation_id = app_org_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON connection_grants TO silo_app;
