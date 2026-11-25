import type { Executor } from '../infra/db.infra';
import type { PolicyTerms, StoredPolicy } from '../engine/mutation/policy.mutation';

/**
 * Who must approve a change: policies, floors, and who may set them.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Which policy applies, whether
 * a floor overrides it and whether somebody may change either are decided in
 * the engine and the service.
 */

export type PolicyAuthority = 'owner_set' | 'delegated' | 'locked';

export interface Governance {
  connectionId: string;
  name: string;
  owningMembershipId: string | null;
  /** The owning scope's path, for a scope admin's claim to the connection. */
  owningScopePath: string | null;
  authority: PolicyAuthority;
  grantedTo: string | null;
}

export type Floor = PolicyTerms & { connectionId: string; setBy: string; setAt: Date };

type PolicyRow = {
  id: string;
  connection_id: string | null;
  scope_id: string | null;
  scope_path: string | null;
  approvals_required: number;
  required_role_id: string | null;
  allow_self_approval: boolean;
  separate_execution: boolean;
  expires_after_hours: number;
};

const mapPolicy = (row: PolicyRow): StoredPolicy => ({
  id: row.id,
  connectionId: row.connection_id,
  scopeId: row.scope_id,
  scopePath: row.scope_path,
  approvalsRequired: row.approvals_required,
  requiredRoleId: row.required_role_id,
  allowSelfApproval: row.allow_self_approval,
  separateExecution: row.separate_execution,
  expiresAfterHours: row.expires_after_hours,
});

/** Every policy in force, with the path of the scope it is set for. */
export async function livePolicies(db: Executor): Promise<StoredPolicy[]> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT p.id, p.connection_id, p.scope_id, s.path::text AS scope_path,
            p.approvals_required, p.required_role_id, p.allow_self_approval,
            p.separate_execution, p.expires_after_hours
       FROM mutation_policies p
       LEFT JOIN scopes s ON s.id = p.scope_id
      WHERE p.superseded_at IS NULL
      ORDER BY p.connection_id NULLS FIRST, s.path NULLS FIRST`,
  );
  return rows.map(mapPolicy);
}

/**
 * Put a policy in force at one level, superseding whatever was there.
 *
 * SUPERSEDED, NOT OVERWRITTEN: the row a past chain was resolved from is still
 * there to be read.
 */
export async function setPolicy(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    connectionId: string | null;
    scopeId: string | null;
    terms: PolicyTerms;
    setBy: string;
  },
): Promise<{ superseded: string | null }> {
  const superseded = await removePolicy(db, { connectionId: input.connectionId, scopeId: input.scopeId });

  await db.query(
    `INSERT INTO mutation_policies
       (id, organisation_id, connection_id, scope_id, approvals_required, required_role_id,
        allow_self_approval, separate_execution, expires_after_hours, set_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.organisationId,
      input.connectionId,
      input.scopeId,
      input.terms.approvalsRequired,
      input.terms.requiredRoleId,
      input.terms.allowSelfApproval,
      input.terms.separateExecution,
      input.terms.expiresAfterHours,
      input.setBy,
    ],
  );

  return { superseded };
}

/** Take the policy at one level out of force. Returns the id it superseded, if any. */
export async function removePolicy(
  db: Executor,
  input: { connectionId: string | null; scopeId: string | null },
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE mutation_policies SET superseded_at = now()
      WHERE superseded_at IS NULL
        AND connection_id IS NOT DISTINCT FROM $1
        AND scope_id IS NOT DISTINCT FROM $2
      RETURNING id`,
    [input.connectionId, input.scopeId],
  );
  return rows[0]?.id ?? null;
}

type FloorRow = {
  connection_id: string;
  approvals_required: number;
  required_role_id: string | null;
  allow_self_approval: boolean;
  separate_execution: boolean;
  expires_after_hours: number;
  set_by: string;
  set_at: Date;
};

const mapFloor = (row: FloorRow): Floor => ({
  connectionId: row.connection_id,
  approvalsRequired: row.approvals_required,
  requiredRoleId: row.required_role_id,
  allowSelfApproval: row.allow_self_approval,
  separateExecution: row.separate_execution,
  expiresAfterHours: row.expires_after_hours,
  setBy: row.set_by,
  setAt: row.set_at,
});

export async function floors(db: Executor): Promise<Floor[]> {
  const { rows } = await db.query<FloorRow>(
    `SELECT connection_id, approvals_required, required_role_id, allow_self_approval,
            separate_execution, expires_after_hours, set_by, set_at
       FROM mutation_policy_floors ORDER BY connection_id`,
  );
  return rows.map(mapFloor);
}

export async function setFloor(
  db: Executor,
  input: { organisationId: string; connectionId: string; terms: PolicyTerms; setBy: string },
): Promise<void> {
  await db.query(
    `INSERT INTO mutation_policy_floors
       (connection_id, organisation_id, approvals_required, required_role_id,
        allow_self_approval, separate_execution, expires_after_hours, set_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (connection_id) DO UPDATE
        SET approvals_required  = EXCLUDED.approvals_required,
            required_role_id    = EXCLUDED.required_role_id,
            allow_self_approval = EXCLUDED.allow_self_approval,
            separate_execution  = EXCLUDED.separate_execution,
            expires_after_hours = EXCLUDED.expires_after_hours,
            set_by              = EXCLUDED.set_by,
            set_at              = now()`,
    [
      input.connectionId,
      input.organisationId,
      input.terms.approvalsRequired,
      input.terms.requiredRoleId,
      input.terms.allowSelfApproval,
      input.terms.separateExecution,
      input.terms.expiresAfterHours,
      input.setBy,
    ],
  );
}

export async function removeFloor(db: Executor, connectionId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM mutation_policy_floors WHERE connection_id = $1', [connectionId]);
  return (rowCount ?? 0) > 0;
}

type GovernanceRow = {
  id: string;
  name: string;
  owning_membership_id: string | null;
  owning_scope_path: string | null;
  policy_authority: PolicyAuthority;
  policy_authority_granted_to: string | null;
};

/** Who owns each connection, and where its policy authority sits. */
export async function governanceOf(db: Executor, connectionIds: readonly string[]): Promise<Governance[]> {
  const { rows } = await db.query<GovernanceRow>(
    `SELECT c.id, c.name, c.owning_membership_id, s.path::text AS owning_scope_path,
            c.policy_authority, c.policy_authority_granted_to
       FROM connections c
       LEFT JOIN scopes s ON s.id = c.owning_scope_id
      WHERE c.id = ANY($1::uuid[])
      ORDER BY c.id`,
    [[...connectionIds]],
  );
  return rows.map((row) => ({
    connectionId: row.id,
    name: row.name,
    owningMembershipId: row.owning_membership_id,
    owningScopePath: row.owning_scope_path,
    authority: row.policy_authority,
    grantedTo: row.policy_authority_granted_to,
  }));
}

export async function setAuthority(
  db: Executor,
  input: { connectionId: string; authority: PolicyAuthority; grantedTo: string | null; setBy: string },
): Promise<void> {
  await db.query(
    `UPDATE connections
        SET policy_authority = $2,
            policy_authority_granted_to = $3,
            policy_authority_set_by = $4,
            policy_authority_set_at = now()
      WHERE id = $1`,
    [input.connectionId, input.authority, input.grantedTo, input.setBy],
  );
}
