import type { Executor } from '../infra/db.infra';
import type {
  AssignmentScopeType, Clearance, Marking, Permission, Role, RoleAssignment,
} from '../models/authz.model';

/**
 * Roles, assignments, markings and clearances.
 *
 * THE READS HERE ARE ON THE HOT PATH. Every authorisation decision resolves a
 * membership's assignments, scope paths and clearances — so the queries are
 * shaped to answer in one round trip each rather than to read prettily, and the
 * indexes in `004_authz.sql` are partial on `revoked_at IS NULL` because a
 * revoked grant is never the subject of the question.
 */

/* ── Permissions ─────────────────────────────────────────────────────────── */

export async function listPermissions(db: Executor): Promise<Permission[]> {
  const { rows } = await db.query<Permission>(
    `SELECT id, category, description, scopeable FROM permissions ORDER BY category, id`,
  );
  return rows;
}

/* ── Roles ───────────────────────────────────────────────────────────────── */

interface RoleRow {
  id: string;
  organisation_id: string;
  name: string;
  description: string | null;
  system_role: boolean;
  created_at: Date;
}

const mapRole = (row: RoleRow): Role => ({
  id: row.id,
  organisationId: row.organisation_id,
  name: row.name,
  description: row.description,
  systemRole: row.system_role,
  createdAt: row.created_at,
});

export async function createRole(
  db: Executor,
  input: {
    id: string; organisationId: string; name: string;
    description?: string | null; systemRole?: boolean; permissions: readonly string[];
  },
): Promise<Role> {
  const { rows } = await db.query<RoleRow>(
    `INSERT INTO roles (id, organisation_id, name, description, system_role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organisation_id, name, description, system_role, created_at`,
    [input.id, input.organisationId, input.name, input.description ?? null, input.systemRole ?? false],
  );

  if (input.permissions.length > 0) {
    /*
     * `unnest` RATHER THAN A LOOP. One statement, one round trip, and it is
     * atomic — a loop that fails partway leaves a role holding some of the
     * permissions it was meant to have, which is a role nobody configured.
     */
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, unnest($2::text[])`,
      [input.id, input.permissions],
    );
  }

  return mapRole(rows[0]!);
}


export async function listRoles(db: Executor): Promise<Role[]> {
  const { rows } = await db.query<RoleRow>(
    `SELECT id, organisation_id, name, description, system_role, created_at
       FROM roles ORDER BY system_role DESC, name`,
  );
  return rows.map(mapRole);
}

export async function permissionsOfRole(db: Executor, roleId: string): Promise<string[]> {
  const { rows } = await db.query<{ permission_id: string }>(
    `SELECT permission_id FROM role_permissions WHERE role_id = $1`,
    [roleId],
  );
  return rows.map((row) => row.permission_id);
}

export async function setGrantableRoles(
  db: Executor,
  grantingRoleId: string,
  grantableRoleIds: readonly string[],
): Promise<void> {
  await db.query(`DELETE FROM role_grantable_roles WHERE granting_role_id = $1`, [grantingRoleId]);
  if (grantableRoleIds.length > 0) {
    await db.query(
      `INSERT INTO role_grantable_roles (granting_role_id, grantable_role_id)
       SELECT $1, unnest($2::uuid[])`,
      [grantingRoleId, grantableRoleIds],
    );
  }
}

/**
 * Which roles this membership's roles are whitelisted to hand out.
 *
 * MEMBERSHIPS ONLY, AND THAT IS A RULE RATHER THAN AN OMISSION. A machine
 * identity does not delegate: an API key that can widen its own permissions, or
 * hand them to somebody else, turns one leaked secret into an escalation path
 * that no human approved. `checkGrant` refuses a principal subject outright.
 */
export async function grantableRolesFor(db: Executor, membershipId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ grantable_role_id: string }>(
    `SELECT DISTINCT g.grantable_role_id
       FROM role_assignments ra
       JOIN role_grantable_roles g ON g.granting_role_id = ra.role_id
      WHERE ra.membership_id = $1
        AND ra.revoked_at IS NULL
        AND (ra.expires_at IS NULL OR ra.expires_at > now())`,
    [membershipId],
  );
  return new Set(rows.map((row) => row.grantable_role_id));
}

/* ── Assignments ─────────────────────────────────────────────────────────── */

interface AssignmentRow {
  id: string;
  membership_id: string;
  role_id: string;
  scope_type: AssignmentScopeType | null;
  scope_id: string | null;
  granted_by: string;
  granted_at_scope_id: string | null;
  granted_at: Date;
  expires_at: Date | null;
  revoked_by: string | null;
  revoked_at: Date | null;
}

const mapAssignment = (row: AssignmentRow): RoleAssignment => ({
  id: row.id,
  membershipId: row.membership_id,
  roleId: row.role_id,
  scopeType: row.scope_type,
  scopeId: row.scope_id,
  grantedBy: row.granted_by,
  grantedAtScopeId: row.granted_at_scope_id,
  grantedAt: row.granted_at,
  expiresAt: row.expires_at,
  revokedBy: row.revoked_by,
  revokedAt: row.revoked_at,
});

const ASSIGNMENT_COLUMNS = `
  id, membership_id, role_id, scope_type, scope_id, granted_by,
  granted_at_scope_id, granted_at, expires_at, revoked_by, revoked_at
`;

export async function assign(
  db: Executor,
  input: {
    id: string;
    /** Exactly one of these. The table refuses both or neither. */
    membershipId?: string | null;
    principalId?: string | null;
    roleId: string;
    scopeType: AssignmentScopeType | null; scopeId: string | null;
    grantedBy: string; grantedAtScopeId: string | null; expiresAt?: Date | null;
  },
): Promise<RoleAssignment> {
  const { rows } = await db.query<AssignmentRow>(
    /*
     * EXACTLY ONE SUBJECT, ENFORCED BY THE TABLE. `role_assignments_one_subject`
     * refuses a row with both or neither, so a caller that forgets which kind it
     * is holding gets a constraint violation rather than a grant belonging to
     * nobody.
     */
    `INSERT INTO role_assignments
       (id, membership_id, principal_id, role_id, scope_type, scope_id,
        granted_by, granted_at_scope_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ASSIGNMENT_COLUMNS}`,
    [
      input.id, input.membershipId ?? null, input.principalId ?? null,
      input.roleId, input.scopeType, input.scopeId,
      input.grantedBy, input.grantedAtScopeId, input.expiresAt ?? null,
    ],
  );
  return mapAssignment(rows[0]!);
}

/**
 * Live assignments for a membership, with their permissions.
 *
 * ONE QUERY, JOINED AND AGGREGATED. The alternative — read assignments, then
 * read each role's permissions — is N+1 on the hottest path in the product.
 *
 * EXPIRY IS APPLIED IN SQL, NOT AFTERWARDS. An expired grant filtered in the
 * application is a grant that was fetched, and a caller who forgets the filter
 * has silently extended it.
 */
/**
 * Who a set of grants belongs to.
 *
 * TWO KINDS OF SUBJECT, ONE QUERY. A machine identity's permissions are computed
 * by the same statement that computes a person's, because the alternative is two
 * implementations of "what may this subject do" — and two permission engines
 * drift. The one nobody looks at gains a bug, and the bug is that a script can
 * do more than the model says.
 */
export type Subject =
  | { kind: 'membership'; id: string }
  | { kind: 'principal'; id: string };

export async function effectiveAssignments(
  db: Executor,
  subject: Subject | string,
): Promise<Array<RoleAssignment & { permissions: string[]; scopePath: string | null }>> {
  // A bare string is still a membership id: every existing caller passes one.
  const resolved: Subject =
    typeof subject === 'string' ? { kind: 'membership', id: subject } : subject;
  const column = resolved.kind === 'membership' ? 'membership_id' : 'principal_id';
  const { rows } = await db.query<
    AssignmentRow & { permissions: string[] | null; scope_path: string | null }
  >(
    `SELECT ${ASSIGNMENT_COLUMNS.split(',').map((c) => `ra.${c.trim()}`).join(', ')},
            array_agg(rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL) AS permissions,
            s.path::text AS scope_path
       FROM role_assignments ra
       LEFT JOIN role_permissions rp ON rp.role_id = ra.role_id
       LEFT JOIN scopes s ON s.id = ra.scope_id AND ra.scope_type = 'scope'
      WHERE ra.${column} = $1
        AND ra.revoked_at IS NULL
        AND (ra.expires_at IS NULL OR ra.expires_at > now())
      GROUP BY ra.id, ra.membership_id, ra.role_id, ra.scope_type, ra.scope_id,
               ra.granted_by, ra.granted_at_scope_id, ra.granted_at, ra.expires_at,
               ra.revoked_by, ra.revoked_at, s.path`,
    [resolved.id],
  );

  return rows.map((row) => ({
    ...mapAssignment(row),
    permissions: row.permissions ?? [],
    scopePath: row.scope_path,
  }));
}

/**
 * Revoke one assignment.
 *
 * THE `WHERE` NAMES WHO MAY DO IT, AND THAT IS THE REVOCATION AUTHORITY RULE. A
 * grant is revocable by the membership that issued it, by an admin whose subtree
 * contains the scope it was issued under, or by a super admin — not by any admin
 * the user happens to sit under. An Engineering admin cannot revoke access issued
 * by the Falcon admin, even though both administer the same person.
 *
 * Returning null means the caller had no authority over this grant, which the
 * service turns into a denial.
 */
export async function revokeAssignment(
  db: Executor,
  input: {
    assignmentId: string;
    revokedBy: string;
    /** Paths the revoker administers. Empty for a non-admin. */
    revokerScopePaths: readonly string[];
    isSuperAdmin: boolean;
  },
): Promise<RoleAssignment | null> {
  const { rows } = await db.query<AssignmentRow>(
    `UPDATE role_assignments ra
        SET revoked_at = now(), revoked_by = $2
       FROM (SELECT id, granted_at_scope_id FROM role_assignments WHERE id = $1) AS target
       LEFT JOIN scopes gs ON gs.id = target.granted_at_scope_id
      WHERE ra.id = target.id
        AND ra.revoked_at IS NULL
        AND (
          $4::boolean
          OR ra.granted_by = $2
          OR (gs.path IS NOT NULL AND gs.path <@ ANY ($3::ltree[]))
        )
      RETURNING ${ASSIGNMENT_COLUMNS.split(',').map((c) => `ra.${c.trim()}`).join(', ')}`,
    [input.assignmentId, input.revokedBy, input.revokerScopePaths, input.isSuperAdmin],
  );
  return rows[0] ? mapAssignment(rows[0]) : null;
}

export async function listAssignmentsForScope(db: Executor, scopeId: string): Promise<RoleAssignment[]> {
  const { rows } = await db.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM role_assignments
      WHERE scope_id = $1 AND revoked_at IS NULL`,
    [scopeId],
  );
  return rows.map(mapAssignment);
}

/**
 * Grants issued by a membership that outlive them.
 *
 * NO CASCADE ON ADMIN REVOCATION. When an admin is revoked, the grants they
 * issued persist with `granted_by` intact and surface here for review by the
 * admin above them. Cascading would strip access from people who legitimately
 * need it and produce an outage traced to a personnel change.
 */
export async function orphanedGrants(db: Executor, formerAdminId: string): Promise<RoleAssignment[]> {
  const { rows } = await db.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM role_assignments
      WHERE granted_by = $1 AND revoked_at IS NULL`,
    [formerAdminId],
  );
  return rows.map(mapAssignment);
}

/* ── Markings and clearances ─────────────────────────────────────────────── */

export async function createMarking(
  db: Executor,
  input: { id: string; organisationId: string; name: string; kind: Marking['kind']; description?: string | null },
): Promise<Marking> {
  const { rows } = await db.query<{
    id: string; organisation_id: string; name: string;
    kind: Marking['kind']; description: string | null;
  }>(
    `INSERT INTO markings (id, organisation_id, name, kind, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organisation_id, name, kind, description`,
    [input.id, input.organisationId, input.name, input.kind, input.description ?? null],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    kind: row.kind,
    description: row.description,
  };
}

export async function grantClearance(
  db: Executor,
  input: { id: string; membershipId: string; markingId: string; grantedBy: string; expiresAt?: Date | null },
): Promise<Clearance> {
  const { rows } = await db.query<{
    id: string; membership_id: string; marking_id: string; granted_by: string;
    granted_at: Date; expires_at: Date | null; revoked_at: Date | null;
  }>(
    `INSERT INTO clearances (id, membership_id, marking_id, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (membership_id, marking_id)
       DO UPDATE SET revoked_at = NULL, granted_at = now(),
                     granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at
     RETURNING id, membership_id, marking_id, granted_by, granted_at, expires_at, revoked_at`,
    [input.id, input.membershipId, input.markingId, input.grantedBy, input.expiresAt ?? null],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    membershipId: row.membership_id,
    markingId: row.marking_id,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export async function revokeClearance(db: Executor, membershipId: string, markingId: string): Promise<void> {
  await db.query(
    `UPDATE clearances SET revoked_at = COALESCE(revoked_at, now())
      WHERE membership_id = $1 AND marking_id = $2`,
    [membershipId, markingId],
  );
}

/** Marking ids currently held. Expiry and revocation already applied. */
export async function heldMarkings(db: Executor, membershipId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ marking_id: string }>(
    `SELECT marking_id FROM clearances
      WHERE membership_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [membershipId],
  );
  return new Set(rows.map((row) => row.marking_id));
}

export async function markingsOnResource(
  db: Executor,
  resourceType: string,
  resourceId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ marking_id: string }>(
    `SELECT marking_id FROM resource_markings WHERE resource_type = $1 AND resource_id = $2`,
    [resourceType, resourceId],
  );
  return rows.map((row) => row.marking_id);
}

export async function markResource(
  db: Executor,
  input: { id: string; resourceType: string; resourceId: string; markingId: string },
): Promise<void> {
  await db.query(
    `INSERT INTO resource_markings (id, resource_type, resource_id, marking_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource_type, resource_id, marking_id) DO NOTHING`,
    [input.id, input.resourceType, input.resourceId, input.markingId],
  );
}

/**
 * Take a marking off a resource.
 *
 * THE COUNTERPART TO `markResource`, and its absence was why nothing could ever
 * correct a marking. A compartment applied to the wrong concept and unremovable
 * is a feature nobody will use twice.
 */
export async function unmarkResource(
  db: Executor,
  input: { resourceType: string; resourceId: string; markingId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM resource_markings
      WHERE resource_type = $1 AND resource_id = $2 AND marking_id = $3`,
    [input.resourceType, input.resourceId, input.markingId],
  );
  return Boolean(rowCount);
}

/** Markings that exist in this organisation, by id. Used to refuse unknown ones. */
export async function markingIdsInOrganisation(db: Executor): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM markings`);
  return new Set(rows.map((row) => row.id));
}

export async function listMarkings(db: Executor): Promise<Marking[]> {
  const { rows } = await db.query<{
    id: string; organisation_id: string; name: string;
    kind: Marking['kind']; description: string | null;
  }>(`SELECT id, organisation_id, name, kind, description FROM markings ORDER BY kind, name`);
  return rows.map((row) => ({
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    kind: row.kind,
    description: row.description,
  }));
}

/**
 * Withdraw an assignment a directory group conferred.
 *
 * ── NARROWER THAN `revokeAssignment`, AND DELIBERATELY SO ──────────────────
 *
 * That one is a person revoking another person's grant, and it checks that the
 * revoker administers the scope — which is the right question when a human is
 * asking. Nobody is asking here: a directory said somebody left a group, and
 * what follows is the removal of exactly what joining it added.
 *
 * BOUNDED TO THE MAPPING'S OWN TRIPLE. It can only touch an assignment matching
 * this membership, this role and this scope, so it cannot reach a grant a human
 * made for their own reasons that happens to look similar — `granted_by` is
 * what tells those apart and it is checked.
 */
export async function revokeGroupAssignment(
  db: Executor,
  input: { membershipId: string; roleId: string; scopeId: string; grantedBy: string },
): Promise<void> {
  await db.query(
    `UPDATE role_assignments
        SET revoked_at = now()
      WHERE membership_id = $1 AND role_id = $2 AND scope_id = $3
        AND granted_by = $4 AND revoked_at IS NULL`,
    [input.membershipId, input.roleId, input.scopeId, input.grantedBy],
  );
}
