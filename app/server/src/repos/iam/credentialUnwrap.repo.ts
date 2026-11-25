// Data access for iam.credential_unwraps, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report, silo_credential; written by silo_credential.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  credentialUnwrapTable,
  type CredentialUnwrap,
  type CredentialUnwrapPrimaryKey,
  type NewCredentialUnwrap,
} from '../../models/iam/credentialUnwrap.model.ts';

export const credentialUnwrapRepo = {
  insert(db: Queryable, row: NewCredentialUnwrap): Promise<CredentialUnwrap> {
    return insertRow(db, credentialUnwrapTable, row);
  },

  findByKey(db: Queryable, key: CredentialUnwrapPrimaryKey): Promise<CredentialUnwrap | undefined> {
    return findRow(db, credentialUnwrapTable, key);
  },

  /** The organisation's unwraps, newest first, before a (occurred_at, id) cursor (spec 61.9: the credential_unwrapped trail). */
  async list(db: Queryable, f: {
    from?: string | undefined; to?: string | undefined; reason?: string | undefined; credentialId?: string | undefined;
    before?: { occurredAt: string; id: string } | undefined; limit: number;
  }): Promise<CredentialUnwrap[]> {
    const { rows } = await db.query(
      `select ${credentialUnwrapTable.select} from iam.credential_unwraps
       where ($1::timestamptz is null or occurred_at >= $1) and ($2::timestamptz is null or occurred_at < $2) and ($3::text is null or reason = $3)
         and ($4::uuid is null or $4 in (connection_credential_id, identity_provider_id, mfa_factor_id))
         and ($5::timestamptz is null or (occurred_at, id) < ($5::timestamptz, $6::bigint))
       order by occurred_at desc, id desc limit $7`,
      [f.from ?? null, f.to ?? null, f.reason ?? null, f.credentialId ?? null, f.before?.occurredAt ?? null, f.before?.id ?? null, f.limit]);
    return rows as CredentialUnwrap[];
  },
};
