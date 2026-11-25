// Data access for iam.scim_tokens, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scimTokenTable,
  type NewScimToken,
  type ScimToken,
  type ScimTokenChanges,
} from '../../models/iam/scimToken.model.ts';

export const scimTokenRepo = {
  insert(db: Queryable, row: NewScimToken): Promise<ScimToken> {
    return insertRow(db, scimTokenTable, row);
  },

  findById(db: Queryable, id: ScimToken['id']): Promise<ScimToken | undefined> {
    return findRow(db, scimTokenTable, { id });
  },

  findByTokenHash(
    db: Queryable,
    key: Pick<ScimToken, 'organisationId' | 'tokenHash'>,
  ): Promise<ScimToken | undefined> {
    return findRow(db, scimTokenTable, key);
  },

  update(db: Queryable, id: ScimToken['id'], changes: ScimTokenChanges): Promise<ScimToken | undefined> {
    return updateRow(db, scimTokenTable, { id }, changes);
  },

  /** The live token with this hash, its use recorded. Undefined for a revoked or unknown one. */
  async useLive(db: Queryable, organisationId: string, tokenHash: Buffer): Promise<ScimToken | undefined> {
    const { rows } = await db.query(
      `update iam.scim_tokens set last_used_at = now()
        where organisation_id = $1 and token_hash = $2 and revoked_at is null
        returning ${scimTokenTable.select}`, [organisationId, tokenHash]);
    return rows[0] as ScimToken | undefined;
  },

  async list(db: Queryable, organisationId: string): Promise<ScimToken[]> {
    const { rows } = await db.query(
      `select ${scimTokenTable.select} from iam.scim_tokens where organisation_id = $1 order by created_at desc limit 100`, [organisationId]);
    return rows as ScimToken[];
  },

  /** True when this call revoked it. */
  async revoke(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query('update iam.scim_tokens set revoked_at = now() where id = $1 and revoked_at is null', [id]);
    return rowCount === 1;
  },
};
