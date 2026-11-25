// Data access for iam.users, in plain SQL through base.repo.ts; no ORM.
// Read by silo_auth; written by silo_auth.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { userTable, type NewUser, type User, type UserChanges } from '../../models/iam/user.model.ts';

export interface LoginUser {
  id: string;
  passwordHash: string | null;
  ssoOnly: boolean;
  status: User['status'];
  failedAttemptCount: number;
  lockedUntil: string | null;
}

export const userRepo = {
  insert(db: Queryable, row: NewUser): Promise<User> {
    return insertRow(db, userTable, row);
  },

  findById(db: Queryable, id: User['id']): Promise<User | undefined> {
    return findRow(db, userTable, { id });
  },

  findByEmail(db: Queryable, email: User['email']): Promise<User | undefined> {
    return findRow(db, userTable, { email });
  },

  update(db: Queryable, id: User['id'], changes: UserChanges): Promise<User | undefined> {
    return updateRow(db, userTable, { id }, changes);
  },

  // What a login needs, found by email before the user is known (definer function: the
  // user-keyed RLS would hide the row).
  async findForLogin(db: Queryable, email: string): Promise<LoginUser | undefined> {
    const { rows } = await db.query(
      `select id, password_hash as "passwordHash", sso_only as "ssoOnly", status,
              failed_attempt_count as "failedAttemptCount", locked_until as "lockedUntil"
       from iam.find_user_for_login($1)`, [email]);
    return rows[0] as LoginUser | undefined;
  },

  // One failed attempt. At the threshold the account locks for lockMinutes and the count
  // starts again, so the next window is counted afresh (spec 55.3).
  async recordFailedLogin(db: Queryable, id: string, threshold: number, lockMinutes: number)
    : Promise<{ locked: boolean; lockedUntil: string | null }> {
    const { rows } = await db.query(
      `update iam.users set
         failed_attempt_count = case when failed_attempt_count + 1 >= $2 then 0 else failed_attempt_count + 1 end,
         locked_until = case when failed_attempt_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
       where id = $1
       returning locked_until as "lockedUntil", (locked_until is not null and locked_until > now()) as locked`,
      [id, threshold, lockMinutes]);
    return (rows[0] as { locked: boolean; lockedUntil: string | null } | undefined) ?? { locked: false, lockedUntil: null };
  },

  // A successful login clears the counter (spec 55.3) and, when the hashing parameters
  // changed, stores the recomputed hash.
  async recordLogin(db: Queryable, id: string, rehashed?: string): Promise<void> {
    await db.query(
      `update iam.users set failed_attempt_count = 0, locked_until = null, last_seen_at = now(),
              password_hash = coalesce($2, password_hash)
       where id = $1`, [id, rehashed ?? null]);
  },

  async setPassword(db: Queryable, id: string, passwordHash: string): Promise<void> {
    await db.query(
      `update iam.users set password_hash = $2, password_changed_at = now(), failed_attempt_count = 0, locked_until = null
       where id = $1`, [id, passwordHash]);
  },
};
