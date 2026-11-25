// Data access for iam.signups, in plain SQL through base.repo.ts; no ORM.
// Read by silo_auth; written by silo_auth.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  signupTable,
  type NewSignup,
  type Signup,
  type SignupChanges,
} from '../../models/iam/signup.model.ts';

export const signupRepo = {
  insert(db: Queryable, row: NewSignup): Promise<Signup> {
    return insertRow(db, signupTable, row);
  },

  findById(db: Queryable, id: Signup['id']): Promise<Signup | undefined> {
    return findRow(db, signupTable, { id });
  },

  findByTokenHash(db: Queryable, tokenHash: Signup['tokenHash']): Promise<Signup | undefined> {
    return findRow(db, signupTable, { tokenHash });
  },

  update(db: Queryable, id: Signup['id'], changes: SignupChanges): Promise<Signup | undefined> {
    return updateRow(db, signupTable, { id }, changes);
  },

  remove(db: Queryable, id: Signup['id']): Promise<boolean> {
    return deleteRow(db, signupTable, { id });
  },

  /** A sign-up still waiting, by its link's token hash. */
  async findLiveByTokenHash(db: Queryable, tokenHash: Buffer): Promise<Signup | undefined> {
    const { rows } = await db.query(
      `select ${signupTable.select} from iam.signups where token_hash = $1 and completed_at is null and expires_at > now()`, [tokenHash]);
    return rows[0] as Signup | undefined;
  },

  /** Marks it completed by the organisation it created, once. */
  async complete(db: Queryable, id: string, organisationId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update iam.signups set completed_at = now(), created_organisation_id = $2 where id = $1 and completed_at is null and expires_at > now()`, [id, organisationId]);
    return rowCount === 1;
  },

  /** Unverified sign-ups a day past their expiry: the address is not kept for nothing. */
  async purgeExpired(db: Queryable): Promise<number> {
    const { rowCount } = await db.query(`delete from iam.signups where completed_at is null and expires_at < now() - interval '1 day'`);
    return rowCount ?? 0;
  },
};
