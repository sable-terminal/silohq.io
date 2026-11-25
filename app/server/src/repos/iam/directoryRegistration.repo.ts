// Data access for iam.directory_registrations, in plain SQL through base.repo.ts; no ORM.
// Read and written by silo_app (auth). Cell-level, like iam.users: no organisation.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import type { Queryable } from '../base.repo.ts';

export const directoryRegistrationRepo = {
  /** A registration the directory missed: kept to try again (a second failure keeps the first row). */
  async keep(db: Queryable, userId: string, error: string, nextAttemptAt: string): Promise<void> {
    await db.query(
      `insert into iam.directory_registrations (user_id, next_attempt_at, last_error) values ($1, $2, $3) on conflict (user_id) do nothing`,
      [userId, nextAttemptAt, error.slice(0, 200)]);
  },

  async due(db: Queryable, now: string, limit: number): Promise<{ userId: string; attempts: number }[]> {
    const { rows } = await db.query(
      `select user_id as "userId", attempts from iam.directory_registrations where next_attempt_at <= $1 order by next_attempt_at, user_id limit $2`,
      [now, limit]);
    return rows as { userId: string; attempts: number }[];
  },

  async retryLater(db: Queryable, userId: string, attempts: number, error: string, nextAttemptAt: string): Promise<void> {
    await db.query('update iam.directory_registrations set attempts = $2, last_error = $3, next_attempt_at = $4 where user_id = $1',
      [userId, attempts, error.slice(0, 200), nextAttemptAt]);
  },

  async done(db: Queryable, userId: string): Promise<void> {
    await db.query('delete from iam.directory_registrations where user_id = $1', [userId]);
  },
};
