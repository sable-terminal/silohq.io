import type { Executor } from '../infra/db.infra';
import type { AuthMethod, Session } from '../models/session.model';

/**
 * Sessions.
 *
 * NOT UNDER ROW LEVEL SECURITY, because a session belongs to a user rather than
 * an organisation. Every lookup here is by token hash, which is 256 bits of
 * randomness — the token IS the authorisation to read the row.
 *
 * THE PLAINTEXT TOKEN NEVER REACHES THIS FILE. Callers hash it first. A repo that
 * took the plaintext would put it in a query log the moment somebody enabled
 * statement logging to debug something unrelated.
 */

const COLUMNS = `
  id, user_id, active_membership_id, token_hash, issued_at, expires_at,
  revoked_at, last_seen_at, ip_hash, user_agent_hash, auth_method, mfa_satisfied_at
`;

interface Row {
  id: string;
  user_id: string;
  active_membership_id: string | null;
  token_hash: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  auth_method: AuthMethod;
  mfa_satisfied_at: Date | null;
}

function map(row: Row): Session {
  return {
    id: row.id,
    userId: row.user_id,
    activeMembershipId: row.active_membership_id,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    ipHash: row.ip_hash,
    userAgentHash: row.user_agent_hash,
    authMethod: row.auth_method,
    mfaSatisfiedAt: row.mfa_satisfied_at,
  };
}

export async function create(
  db: Executor,
  input: {
    id: string;
    userId: string;
    activeMembershipId: string | null;
    tokenHash: string;
    expiresAt: Date;
    ipHash: string | null;
    userAgentHash: string | null;
    authMethod: AuthMethod;
    mfaSatisfiedAt: Date | null;
  },
): Promise<Session> {
  const { rows } = await db.query<Row>(
    `INSERT INTO sessions
       (id, user_id, active_membership_id, token_hash, expires_at,
        ip_hash, user_agent_hash, auth_method, mfa_satisfied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      input.id, input.userId, input.activeMembershipId, input.tokenHash, input.expiresAt,
      input.ipHash, input.userAgentHash, input.authMethod, input.mfaSatisfiedAt,
    ],
  );
  return map(rows[0]!);
}

/**
 * Find by token hash.
 *
 * IT RETURNS REVOKED AND EXPIRED SESSIONS TOO, AND THAT IS DELIBERATE. Filtering
 * them out here makes a revoked session indistinguishable from a token that was
 * never issued — and those need different handling: one is a person whose access
 * was withdrawn mid-session and should be told, the other is a forgery worth an
 * audit row. `isUsable` in the model decides; this reports.
 */
export async function findByTokenHash(db: Executor, tokenHash: string): Promise<Session | null> {
  // `session_by_token` for the same reason `user_by_email` is used: resolving a
  // request's session is what discovers the user the policy would filter on.
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM session_by_token($1)`, [
    tokenHash,
  ]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * `last_seen_at`, written cheaply.
 *
 * SEPARATE FROM THE LOOKUP AND NOT AWAITED BY THE CALLER'S CRITICAL PATH. Every
 * authenticated request would otherwise turn a read into a write, taking a row
 * lock on the session and serialising a user's concurrent requests behind it.
 * The value is approximate by nature.
 */
export async function touch(
  db: Executor,
  sessionId: string,
  /*
   * ONLY IF IT HAS NOT MOVED SINCE THIS INSTANT. The threshold is the CALLER'S
   * — a repo applies a predicate and does not decide what counts as stale —
   * and having it here rather than in a read-then-write keeps the whole thing
   * one statement with no round trip and no window between the two.
   */
  notSeenSince: Date,
): Promise<void> {
  await db.query(
    `UPDATE sessions SET last_seen_at = now()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)`,
    [sessionId, notSeenSince],
  );
}

export async function revoke(db: Executor, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Every session for a user, gone.
 *
 * FOR A PASSWORD RESET, A DEPROVISION, OR A PERSON WHO PRESSED "SIGN OUT
 * EVERYWHERE". `COALESCE` so a session already revoked keeps its original
 * timestamp — the audit question is when access was withdrawn, and rewriting it
 * on a second sweep loses that.
 *
 * IT RETURNS THE IDS so the caller can delete the matching cache entries. A
 * revocation that updates Postgres and leaves Redis holding the session is a
 * revocation that takes effect when the cache expires, not now.
 */
export async function revokeAllForUser(db: Executor, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [userId],
  );
  return rows.map((row) => row.id);
}

/** Every session acting as one membership. For suspension and removal. */
export async function revokeAllForMembership(db: Executor, membershipId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
      WHERE active_membership_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [membershipId],
  );
  return rows.map((row) => row.id);
}

export async function markMfaSatisfied(db: Executor, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET mfa_satisfied_at = COALESCE(mfa_satisfied_at, now()) WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Sessions a person can see and end from their own account page.
 *
 * ORDERED BY LAST SEEN, because the question being answered is "what is signed in
 * right now" and the current session is the one they are looking at it from.
 */
export async function listActiveForUser(db: Executor, userId: string): Promise<Session[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC NULLS LAST, issued_at DESC`,
    [userId],
  );
  return rows.map(map);
}

/**
 * Remove sessions that expired long ago.
 *
 * NOT AT EXPIRY — AFTER A DELAY. An expired session is still evidence: "when did
 * this person last sign in, and from where" is a question asked after an incident,
 * and deleting the row the moment it expires answers it with silence.
 */
export async function deleteExpiredBefore(db: Executor, before: Date): Promise<number> {
  // A sweeper acts for nobody, so `sessions_own` would match no rows and the
  // delete would report success having removed nothing.
  const { rows } = await db.query<{ removed: string }>(
    `SELECT delete_expired_sessions($1)::text AS removed`,
    [before],
  );
  const rowCount = Number(rows[0]?.removed ?? 0);
  return rowCount ?? 0;
}
