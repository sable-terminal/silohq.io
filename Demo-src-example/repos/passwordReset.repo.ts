import type { Executor } from '../infra/db.infra';

/**
 * Password resets.
 *
 * SINGLE USE, ENFORCED IN THE `WHERE` CLAUSE OF THE CONSUME. Checking whether a
 * token is unused and then marking it used is two statements with a window
 * between them, and in that window the same link clicked twice sets the password
 * twice — which matters when the second click is somebody else with the same
 * email in their inbox.
 *
 * CONSUMING ONE MUST REVOKE EVERY SESSION FOR THAT USER. That is the caller's
 * job, in the same transaction as this. A reset is what somebody does when they
 * believe their account is compromised, and leaving the attacker's session alive
 * is the one outcome that must not happen.
 */

export interface PasswordReset {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export async function create(
  db: Executor,
  input: { id: string; userId: string; tokenHash: string; requestedIpHash: string | null; expiresAt: Date },
): Promise<void> {
  /*
   * ANY OUTSTANDING RESET IS INVALIDATED FIRST. Two live tokens means an old
   * email — possibly the one an attacker triggered — still works after the user
   * requests a fresh one. Requesting a reset should make every earlier one dead.
   */
  await db.query(
    `UPDATE password_resets SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [input.userId],
  );

  await db.query(
    `INSERT INTO password_resets (id, user_id, token_hash, requested_ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.id, input.userId, input.tokenHash, input.requestedIpHash, input.expiresAt],
  );
}

/**
 * Consume a token, returning the user it belonged to.
 *
 * ONE STATEMENT: THE CHECK AND THE MARK ARE THE SAME WRITE. A null return means
 * the token was wrong, already used, or expired — and the caller must not
 * distinguish those to the person, because doing so says whether a token ever
 * existed.
 */
export async function consume(db: Executor, tokenHash: string): Promise<{ userId: string } | null> {
  /*
   * `consume_password_reset` is `SECURITY DEFINER` and still one statement. The
   * person holding a reset link has no session, so `password_resets_own` matches
   * nothing for them — a direct UPDATE would consume no row and report the token
   * as invalid, which is the correct-looking answer to a perfectly good link.
   */
  const { rows } = await db.query<{ user_id: string | null }>(
    `SELECT consume_password_reset($1) AS user_id`,
    [tokenHash],
  );
  return rows[0]?.user_id ? { userId: rows[0].user_id } : null;
}

/** For the rate limiter: how many resets this user has asked for recently. */
export async function countRecentForUser(
  db: Executor,
  userId: string,
  since: Date,
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM password_resets WHERE user_id = $1 AND created_at > $2`,
    [userId, since],
  );
  return Number(rows[0]?.count ?? 0);
}
