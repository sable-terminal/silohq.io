// Data access for iam.password_resets, in plain SQL through base.repo.ts; no ORM.
// Read by silo_auth; written by silo_auth.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  passwordResetTable,
  type NewPasswordReset,
  type PasswordReset,
  type PasswordResetChanges,
} from '../../models/iam/passwordReset.model.ts';

export const passwordResetRepo = {
  insert(db: Queryable, row: NewPasswordReset): Promise<PasswordReset> {
    return insertRow(db, passwordResetTable, row);
  },

  findById(db: Queryable, id: PasswordReset['id']): Promise<PasswordReset | undefined> {
    return findRow(db, passwordResetTable, { id });
  },

  findByTokenHash(db: Queryable, tokenHash: PasswordReset['tokenHash']): Promise<PasswordReset | undefined> {
    return findRow(db, passwordResetTable, { tokenHash });
  },

  update(
    db: Queryable,
    id: PasswordReset['id'],
    changes: PasswordResetChanges,
  ): Promise<PasswordReset | undefined> {
    return updateRow(db, passwordResetTable, { id }, changes);
  },

  // Consumes a reset once and, in the same statement, sets the new password and revokes
  // every session of the user (spec 55.3 binding rule). Undefined for a token that is
  // unknown, used or expired; then nothing changes.
  async consume(db: Queryable, tokenHash: Buffer, passwordHash: string)
    : Promise<{ userId: string; revokedSessionIds: string[] } | undefined> {
    const { rows } = await db.query(
      'select user_id as "userId", revoked_session_ids as "revokedSessionIds" from iam.consume_password_reset($1, $2)',
      [tokenHash, passwordHash]);
    return rows[0] as { userId: string; revokedSessionIds: string[] } | undefined;
  },
};
