import type { Executor } from '../infra/db.infra';
import type { ConnectionGrant, ReachEntry, RevokedGrant } from '../models/connection.model';
import { generateId } from '../utils/tokens.util';

/**
 * Who reaches a connection: the grants themselves, and the people those grants
 * add up to.
 *
 * SQL AND THE ROW-TO-MODEL MAPPING. Whether a `per_user` connector may be
 * granted to a group, whether writes may be granted at all, and what a grant
 * that was already revoked means to the caller are all judgements, and they live
 * in `services/connectionGrant.service.ts`.
 *
 * `connection_grants` IS DEFAULT DENY, so the interesting statement in this file
 * is `reach` — the grants issued and the people who can actually reach a
 * connection are different lists, and they diverge the moment scopes nest.
 */

const COLUMNS = `
  id, organisation_wide, scope_id, membership_id, principal_id,
  can_read, can_write, include_descendants, granted_at, expires_at, revoked_at
`;

interface Row {
  id: string;
  organisation_wide: boolean;
  scope_id: string | null;
  membership_id: string | null;
  principal_id: string | null;
  can_read: boolean;
  can_write: boolean;
  include_descendants: boolean;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function map(row: Row): ConnectionGrant {
  return {
    id: row.id,
    organisationWide: row.organisation_wide,
    scopeId: row.scope_id,
    membershipId: row.membership_id,
    principalId: row.principal_id,
    canRead: row.can_read,
    canWrite: row.can_write,
    includeDescendants: row.include_descendants,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Issue a grant. Returns its id.
 *
 * EVERY GRANTEE COLUMN IS NAMED, INCLUDING THE THREE THAT WILL BE NULL. 016's
 * `one_grantee` check counts the four and demands exactly one, so the row is
 * only well formed when the caller has decided which — and a statement that
 * omitted the columns would leave that decision to whatever the defaults happen
 * to be today.
 */
export async function insert(
  db: Executor,
  input: {
    connectionId: string;
    organisationWide: boolean;
    scopeId: string | null;
    membershipId: string | null;
    principalId: string | null;
    canRead: boolean;
    canWrite: boolean;
    includeDescendants: boolean;
    grantedBy: string;
    /**
     * Revision 5 — "The `granted_at_scope` column is now LOAD-BEARING for
     * revocation authority, not only for audit."
     *
     * It was declared in 016 with a comment saying exactly that, and omitted
     * from this insert, so it was NULL on every row ever written and the rule
     * it exists for had nothing to read. Null still means something — the
     * granter was acting organisation-wide — and then only they or a super
     * admin may withdraw it.
     */
    grantedAtScopeId: string | null;
    expiresAt: Date | null;
  },
): Promise<string> {
  const grantId = generateId();

  await db.query(
    `INSERT INTO connection_grants
       (id, connection_id, organisation_wide, scope_id, membership_id, principal_id,
        can_read, can_write, include_descendants, granted_by, granted_at_scope_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      grantId,
      input.connectionId,
      input.organisationWide,
      input.scopeId,
      input.membershipId,
      input.principalId,
      input.canRead,
      input.canWrite,
      input.includeDescendants,
      input.grantedBy,
      input.grantedAtScopeId,
      input.expiresAt,
    ],
  );

  return grantId;
}

/**
 * Revoke one grant. Null when there was no live grant by that id.
 *
 * `revoked_at IS NULL` IS HERE SO A SECOND REVOCATION IS NOT ONE. Without it the
 * statement would move `revoked_at` forward on a grant somebody else had already
 * withdrawn, rewriting when access actually ended — and the caller, which cannot
 * tell the two apart, would audit a revocation that did not happen.
 *
 * IT RETURNS WHO THE GRANT NAMED, because the audit entry is written after the
 * row has already been changed and the grantee is no longer readable anywhere
 * else in the transaction without a second statement.
 */
/**
 * Revision 5 — who may withdraw a grant.
 *
 * "A grant is revocable only by: the membership that issued it, any admin whose
 * subtree contains the grant's `granted_at_scope`, a super admin. NOT BY ANY
 * ADMIN THE USER HAPPENS TO SIT UNDER. An Engineering admin cannot revoke
 * access issued by the Falcon admin."
 *
 * THE AUTHORITY IS IN THE STATEMENT, not in a check above it. This is the same
 * shape `authz.repo.revokeAssignment` uses for role assignments, which had the
 * rule right all along; the connection path had no authority predicate at all,
 * so any holder of `connection.grant` could withdraw any grant in the
 * organisation including a peer admin's.
 *
 * A NULL `granted_at_scope_id` MEANS ORGANISATION-WIDE, and no subtree contains
 * it. Those are revocable by their issuer or a super admin, which is the
 * correct answer rather than an omission: nobody administers a subtree that
 * contains the whole organisation except somebody who administers all of it.
 */
export async function revoke(
  db: Executor,
  input: {
    grantId: string;
    revokedBy: string;
    /** Paths the revoker administers. Empty for a non-admin. */
    revokerScopePaths: readonly string[];
    isSuperAdmin: boolean;
  },
): Promise<RevokedGrant | null> {
  const { rows } = await db.query<{
    connection_id: string;
    organisation_wide: boolean;
    scope_id: string | null;
    membership_id: string | null;
    principal_id: string | null;
  }>(
    `UPDATE connection_grants g
        SET revoked_by = $2, revoked_at = now()
       FROM (SELECT id, granted_at_scope_id FROM connection_grants WHERE id = $1) AS target
       LEFT JOIN scopes gs ON gs.id = target.granted_at_scope_id
      WHERE g.id = target.id
        AND g.revoked_at IS NULL
        AND (
          $4::boolean
          OR g.granted_by = $2
          OR (gs.path IS NOT NULL AND gs.path <@ ANY ($3::ltree[]))
        )
      RETURNING g.connection_id, g.organisation_wide, g.scope_id, g.membership_id, g.principal_id`,
    [input.grantId, input.revokedBy, input.revokerScopePaths, input.isSuperAdmin],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    connectionId: row.connection_id,
    organisationWide: row.organisation_wide,
    scopeId: row.scope_id,
    membershipId: row.membership_id,
    principalId: row.principal_id,
  };
}

/** Withdraw every live grant on a connection, in one statement. */
export async function revokeAllFor(
  db: Executor,
  input: { connectionId: string; revokedBy: string },
): Promise<void> {
  await db.query(
    `UPDATE connection_grants SET revoked_by = $2, revoked_at = now()
      WHERE connection_id = $1 AND revoked_at IS NULL`,
    [input.connectionId, input.revokedBy],
  );
}

/**
 * Every grant ever issued on a connection, newest first.
 *
 * REVOKED AND EXPIRED ROWS COME BACK. "Who can see this" and "who could see this
 * last month" are both questions somebody asks, and a `WHERE revoked_at IS NULL`
 * here would answer only the first for every caller — which of the two a given
 * screen wants is the service's question.
 */
export async function list(db: Executor, connectionId: string): Promise<ConnectionGrant[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM connection_grants
      WHERE connection_id = $1
      ORDER BY granted_at DESC`,
    [connectionId],
  );

  return rows.map(map);
}

/**
 * Everyone who can currently reach a connection, and the route that got them
 * there.
 *
 * NOT THE GRANTS ISSUED, WHICH IS A DIFFERENT LIST AND DIVERGES THE MOMENT
 * SCOPES NEST. A grant on Engineering with descendants reaches everybody in
 * Platform and Data too, and reading the three rows somebody typed and doing the
 * arithmetic in your head is exactly the step that gets skipped.
 *
 * THE `live` CTE'S PREDICATES ARE CORRECTNESS, NOT ACCESS CONTROL. A revoked or
 * expired grant is somebody who USED to be able to reach this, and a read-less
 * grant reaches nothing — counting either as present makes this answer a
 * different question from the one it is asked.
 */
export async function reach(
  db: Executor,
  input: { connectionId: string; organisationId: string },
): Promise<ReachEntry[]> {
  const { rows } = await db.query<{
    membership_id: string;
    first_name: string;
    last_name: string;
    email: string;
    can_write: boolean;
    via: ReachEntry['via'];
    via_name: string | null;
  }>(
    `WITH live AS (
       SELECT * FROM connection_grants
        WHERE connection_id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND can_read
     ),
     people AS (
       /* Everyone, when the connection is the organisation's. */
       SELECT m.id AS membership_id, g.can_write,
              'organisation'::text AS via, NULL::text AS via_name
         FROM live g
         JOIN memberships m ON m.organisation_id = $2 AND m.status = 'active'
        WHERE g.organisation_wide

       UNION ALL

       /* A scope, and its subtree when the grant says so. */
       SELECT sm.membership_id, g.can_write, 'scope'::text, granted.name
         FROM live g
         JOIN scopes granted ON granted.id = g.scope_id
         JOIN scopes reached
           ON reached.id = granted.id
           OR (g.include_descendants AND reached.path <@ granted.path)
         JOIN scope_memberships sm ON sm.scope_id = reached.id

       UNION ALL

       /* One person, named. */
       SELECT g.membership_id, g.can_write, 'membership'::text, NULL::text
         FROM live g WHERE g.membership_id IS NOT NULL
     )
     SELECT p.membership_id,
            u.first_name, u.last_name, u.email,
            bool_or(p.can_write) AS can_write,
            /* The broadest route wins the label: if the organisation has
               it, saying "via the Finance scope" would be misleading. */
            min(CASE p.via WHEN 'organisation' THEN 1 WHEN 'scope' THEN 2 ELSE 3 END) AS rank,
            (array_agg(p.via ORDER BY CASE p.via WHEN 'organisation' THEN 1
                                                 WHEN 'scope' THEN 2 ELSE 3 END))[1] AS via,
            (array_agg(p.via_name ORDER BY CASE p.via WHEN 'organisation' THEN 1
                                                      WHEN 'scope' THEN 2 ELSE 3 END))[1] AS via_name
       FROM people p
       JOIN memberships m ON m.id = p.membership_id AND m.status = 'active'
       JOIN users u ON u.id = m.user_id
      GROUP BY p.membership_id, u.first_name, u.last_name, u.email
      ORDER BY u.first_name, u.last_name`,
    [input.connectionId, input.organisationId],
  );

  return rows.map((row) => ({
    membershipId: row.membership_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    canWrite: row.can_write,
    via: row.via,
    viaName: row.via_name,
  }));
}
