import type { Executor } from '../infra/db.infra';
import type { Invitation } from '../models/invitation.model';

/**
 * Invitations.
 *
 * LOOKED UP BY TOKEN HASH, NEVER BY EMAIL, ON THE ACCEPTANCE PATH. Finding an
 * invitation by address would let anybody enumerate who has been invited to a
 * tenant by trying addresses — and the acceptance endpoint is unauthenticated by
 * definition, because the person accepting has no session yet.
 */

const COLUMNS = `
  id, organisation_id, email, token_hash, role_id, scope_id, seat_id,
  invited_by, expires_at, accepted_at, revoked_at, created_at
`;

interface Row {
  id: string;
  organisation_id: string;
  email: string;
  token_hash: string;
  role_id: string | null;
  scope_id: string | null;
  seat_id: string | null;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function map(row: Row): Invitation {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    email: row.email,
    tokenHash: row.token_hash,
    roleId: row.role_id,
    scopeId: row.scope_id,
    seatId: row.seat_id,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

/**
 * By token hash.
 *
 * UNTENANTED BY NECESSITY. Acceptance happens before the invitee is a member of
 * anything, so there is no tenant context to set — the token is what identifies
 * the organisation, not the other way round. The caller declares it.
 */
export async function findByTokenHash(db: Executor, tokenHash: string): Promise<Invitation | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM invitations WHERE token_hash = $1`, [
    tokenHash,
  ]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The invitation, and the name of the organisation it is into.
 *
 * WHY IT IS NOT `findByTokenHash` WITH A JOIN. That one reads the table, so it
 * returns nothing when no tenant context is set — which on the acceptance path
 * is always, and an empty result there reads as "no such invitation" rather than
 * as "row level security refused you". This goes through `invitation_by_token`
 * from 002, a `SECURITY DEFINER` function that takes a hash and returns at most
 * one row, so holding the token is the only way to get anything out of it.
 *
 * THE NAME TRAVELS WITH IT BECAUSE A TOKEN HOLDER IS NOT YET A MEMBER. The
 * acceptance page has to say which organisation this is; reading `organisations`
 * separately would need a tenant context the caller does not have, and giving it
 * one before the token has been validated is what §RLS exists to prevent.
 */
export interface InvitationByToken {
  invitation: Invitation;
  organisationName: string;
}

export async function findByToken(
  db: Executor,
  tokenHash: string,
): Promise<InvitationByToken | null> {
  const { rows } = await db.query<Row & { organisation_name: string }>(
    'SELECT * FROM invitation_by_token($1)',
    [tokenHash],
  );

  const row = rows[0];
  return row ? { invitation: map(row), organisationName: row.organisation_name } : null;
}

/**
 * Claim an invitation without a tenant context, atomically.
 *
 * THE SINGLE-USE CHECK IS INSIDE THE FUNCTION'S OWN `WHERE`, which is what makes
 * two simultaneous acceptances race rather than both proceeding. It returns the
 * id it marked, or null when there was nothing left to mark — the service
 * decides whether that means "already used" or something else.
 *
 * SEPARATE FROM `markAccepted` RATHER THAN A VARIANT OF IT. That one is the
 * ordinary tenanted write for a caller who already knows the id; this one is
 * reached with only a token, before the organisation is known.
 */
export async function claimByToken(db: Executor, tokenHash: string): Promise<string | null> {
  const { rows } = await db.query<{ claim_invitation: string | null }>(
    'SELECT claim_invitation($1)',
    [tokenHash],
  );
  return rows[0]?.claim_invitation ?? null;
}

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    email: string;
    tokenHash: string;
    roleId?: string | null;
    scopeId?: string | null;
    seatId?: string | null;
    invitedBy: string;
    expiresAt: Date;
  },
): Promise<Invitation> {
  const { rows } = await db.query<Row>(
    `INSERT INTO invitations
       (id, organisation_id, email, token_hash, role_id, scope_id, seat_id, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      input.id, input.organisationId, input.email, input.tokenHash,
      input.roleId ?? null, input.scopeId ?? null, input.seatId ?? null,
      input.invitedBy, input.expiresAt,
    ],
  );
  return map(rows[0]!);
}

/**
 * Mark accepted.
 *
 * THE `WHERE` REJECTS AN ALREADY-USED INVITATION IN THE SAME STATEMENT, so two
 * simultaneous acceptances cannot both succeed. Checking first and updating after
 * leaves a window in which both reads see `accepted_at` null, and the tenant gains
 * two memberships from one invitation — one of which holds a seat nobody
 * allocated.
 */
export async function markAccepted(db: Executor, id: string): Promise<Invitation | null> {
  const { rows } = await db.query<Row>(
    `UPDATE invitations SET accepted_at = now()
      WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function revoke(db: Executor, id: string): Promise<void> {
  await db.query(
    `UPDATE invitations SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND accepted_at IS NULL`,
    [id],
  );
}

/**
 * Adopt the invitation's organisation for the rest of this transaction.
 *
 * IT BELONGS BESIDE `actAsUser` IN `infra/db`, AND SO DOES `sso.repo`'s COPY OF
 * IT. Both are here for the same reason: a service may hold no SQL, and both
 * domains establish a tenant partway through an untenanted transaction — the
 * person is discovered without one, and everything written afterwards is an
 * ordinary tenanted write that `WITH CHECK (organisation_id = app_org_id())`
 * governs. Two copies of one statement is what the layering test exists to
 * prevent; moving them is a change to `infra/db`, which is not this pass.
 *
 * `set_config(..., true)` IS `SET LOCAL`. A plain `SET` outlives the transaction
 * on a pooled connection and hands the next request this organisation's context.
 */
export async function actAsOrganisation(db: Executor, organisationId: string): Promise<void> {
  await db.query('SELECT set_config($1, $2, true)', ['app.org_id', organisationId]);
}

/** Outstanding invitations in the current organisation. Needs a tenant context. */
export async function listPending(db: Executor): Promise<Invitation[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM invitations
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
  );
  return rows.map(map);
}
