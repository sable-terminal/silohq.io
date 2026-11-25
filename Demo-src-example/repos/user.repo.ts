import type { Executor } from '../infra/db.infra';
import type { User } from '../models/user.model';

/**
 * Users.
 *
 * `users` IS NOT UNDER ROW LEVEL SECURITY. A user is global — one person may
 * belong to organisations in different tenants — so there is no `organisation_id`
 * to write a policy against. What constrains access is that reaching a user goes
 * through `memberships`, which is under RLS.
 *
 * WHICH MEANS THE QUERIES HERE ARE NOT TENANT-SCOPED BY THE DATABASE, and the
 * service layer must not treat them as if they were. `findByEmail` will find a
 * user in any tenant, because at login there is no tenant yet.
 */

const COLUMNS = `
  id, first_name, last_name, email, email_verified_at, password_hash,
  password_changed_at, failed_attempt_count, locked_until, avatar_object_key,
  avatar_content_type, status, created_at, last_seen_at
`;

interface Row {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  email_verified_at: Date | null;
  password_hash: string | null;
  password_changed_at: Date | null;
  failed_attempt_count: number;
  locked_until: Date | null;
  avatar_object_key: string | null;
  avatar_content_type: string | null;
  status: User['status'];
  created_at: Date;
  last_seen_at: Date | null;
}

function map(row: Row): User {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    passwordChangedAt: row.password_changed_at,
    failedAttemptCount: row.failed_attempt_count,
    lockedUntil: row.locked_until,
    avatarObjectKey: row.avatar_object_key,
    avatarContentType: row.avatar_content_type,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function findById(db: Executor, id: string): Promise<User | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * By email.
 *
 * THE COLUMN IS `citext`, SO THE COMPARISON IS CASE-INSENSITIVE IN THE DATABASE
 * rather than by lowercasing here. Doing it in the application means one code
 * path that forgets, and `Tommy@` then registers a second account beside
 * `tommy@`.
 */
export async function findByEmail(db: Executor, email: string): Promise<User | null> {
  /*
   * THROUGH `user_by_email`, WHICH IS `SECURITY DEFINER`. This is the lookup
   * that establishes who is signing in, so there is no `app.user_id` yet for
   * `users_own` to match — a direct SELECT returns nothing and reads as "no such
   * account", which is indistinguishable from a wrong address.
   */
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM user_by_email($1)`, [email]);
  return rows[0] ? map(rows[0]) : null;
}

export async function create(
  db: Executor,
  input: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    passwordHash: string | null;
  },
): Promise<User> {
  const { rows } = await db.query<Row>(
    `INSERT INTO users (id, first_name, last_name, email, password_hash, password_changed_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
     RETURNING ${COLUMNS}`,
    [input.id, input.firstName, input.lastName, input.email, input.passwordHash],
  );
  return map(rows[0]!);
}

/**
 * Record a failed attempt and lock if the threshold is reached.
 *
 * COUNTED AND COMPARED IN ONE STATEMENT, NOT READ-THEN-WRITE. Two simultaneous
 * attempts that both read a count of 7 would both write 8, and the account would
 * never reach the threshold however many times it was tried. The increment
 * happens where the row is locked.
 */
export async function recordFailedAttempt(
  db: Executor,
  userId: string,
  threshold: number,
  lockoutSeconds: number,
): Promise<{ failedAttemptCount: number; locked: boolean }> {
  const { rows } = await db.query<{ failed_attempt_count: number; locked_until: Date | null }>(
    `UPDATE users
        SET failed_attempt_count = failed_attempt_count + 1,
            locked_until = CASE
              WHEN failed_attempt_count + 1 >= $2 THEN now() + make_interval(secs => $3)
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_attempt_count, locked_until`,
    [userId, threshold, lockoutSeconds],
  );

  const row = rows[0];
  return {
    failedAttemptCount: row?.failed_attempt_count ?? 0,
    locked: row?.locked_until !== null && row?.locked_until !== undefined,
  };
}

/** Clear the counter and the lock. Called on a successful authentication. */
export async function clearFailedAttempts(db: Executor, userId: string): Promise<void> {
  await db.query(
    `UPDATE users SET failed_attempt_count = 0, locked_until = NULL, last_seen_at = now()
      WHERE id = $1`,
    [userId],
  );
}

export async function updatePasswordHash(
  db: Executor,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db.query(
    `UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
    [userId, passwordHash],
  );
}

export async function markEmailVerified(db: Executor, userId: string): Promise<void> {
  await db.query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
    [userId],
  );
}
