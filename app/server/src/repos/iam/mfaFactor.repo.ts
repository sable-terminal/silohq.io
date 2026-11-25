// Data access for iam.mfa_factors, in plain SQL through base.repo.ts; no ORM.
// Read by silo_auth; written by silo_auth.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mfaFactorTable,
  type MfaFactor,
  type MfaFactorChanges,
  type NewMfaFactor,
} from '../../models/iam/mfaFactor.model.ts';

export const mfaFactorRepo = {
  insert(db: Queryable, row: NewMfaFactor): Promise<MfaFactor> {
    return insertRow(db, mfaFactorTable, row);
  },

  findById(db: Queryable, id: MfaFactor['id']): Promise<MfaFactor | undefined> {
    return findRow(db, mfaFactorTable, { id });
  },

  update(db: Queryable, id: MfaFactor['id'], changes: MfaFactorChanges): Promise<MfaFactor | undefined> {
    return updateRow(db, mfaFactorTable, { id }, changes);
  },

  // Confirmed, unrevoked TOTP factors of a user: the ones a code is checked against.
  async listUsableTotp(db: Queryable, userId: string): Promise<MfaFactor[]> {
    const { rows } = await db.query(
      `select ${mfaFactorTable.select} from iam.mfa_factors
       where user_id = $1 and kind = 'totp' and confirmed_at is not null and revoked_at is null
       order by created_at`, [userId]);
    return rows as MfaFactor[];
  },

  async countConfirmed(db: Queryable, userId: string): Promise<number> {
    const { rows } = await db.query(
      'select count(*)::int as n from iam.mfa_factors where user_id = $1 and confirmed_at is not null and revoked_at is null', [userId]);
    return (rows[0] as { n: number }).n;
  },

  async listUsableWebauthn(db: Queryable, userId: string): Promise<MfaFactor[]> {
    const { rows } = await db.query(
      `select ${mfaFactorTable.select} from iam.mfa_factors
       where user_id = $1 and kind = 'webauthn' and confirmed_at is not null and revoked_at is null
       order by created_at`, [userId]);
    return rows as MfaFactor[];
  },

  // Accepts a WebAuthn assertion only if it moves the signature counter on from the value
  // read (or both stay 0, for authenticators that keep none), so one assertion works once
  // and a cloned authenticator is caught.
  async acceptCounter(db: Queryable, id: string, from: number, to: number): Promise<boolean> {
    const { rowCount } = await db.query(
      `update iam.mfa_factors set sign_count = $3, last_used_at = now()
       where id = $1 and revoked_at is null and sign_count = $2 and ($3 > $2 or ($2 = 0 and $3 = 0))`, [id, from, to]);
    return rowCount === 1;
  },

  // Accepts a TOTP step only if it moves last_used_step forward, so a code works once even
  // when two logins race with it (decision 2026-10-29).
  async acceptStep(db: Queryable, id: string, step: number): Promise<boolean> {
    const { rowCount } = await db.query(
      `update iam.mfa_factors set last_used_step = $2, last_used_at = now()
       where id = $1 and revoked_at is null and (last_used_step is null or last_used_step < $2)`, [id, step]);
    return rowCount === 1;
  },

  // Confirms an enrolment with its first code, which is then used.
  async confirm(db: Queryable, id: string, step: number): Promise<boolean> {
    const { rowCount } = await db.query(
      `update iam.mfa_factors set confirmed_at = now(), last_used_step = $2, last_used_at = now()
       where id = $1 and confirmed_at is null and revoked_at is null and (last_used_step is null or last_used_step < $2)`, [id, step]);
    return rowCount === 1;
  },

  /** A person's factors not removed, confirmed or not, oldest first. */
  async listLive(db: Queryable, userId: string): Promise<MfaFactor[]> {
    const { rows } = await db.query(
      `select ${mfaFactorTable.select} from iam.mfa_factors where user_id = $1 and revoked_at is null order by created_at, id`, [userId]);
    return rows as MfaFactor[];
  },
};
