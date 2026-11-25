// Data access for iam.scim_groups, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scimGroupTable,
  type NewScimGroup,
  type ScimGroup,
  type ScimGroupChanges,
} from '../../models/iam/scimGroup.model.ts';

export const scimGroupRepo = {
  insert(db: Queryable, row: NewScimGroup): Promise<ScimGroup> {
    return insertRow(db, scimGroupTable, row);
  },

  findById(db: Queryable, id: ScimGroup['id']): Promise<ScimGroup | undefined> {
    return findRow(db, scimGroupTable, { id });
  },

  update(db: Queryable, id: ScimGroup['id'], changes: ScimGroupChanges): Promise<ScimGroup | undefined> {
    return updateRow(db, scimGroupTable, { id }, changes);
  },

  /** Live groups, filtered as SCIM clients look them up (eq only), in pages. */
  async listLive(db: Queryable, filter: { id?: string; displayName?: string; externalId?: string }, offset: number, limit: number)
    : Promise<{ total: number; groups: ScimGroup[] }> {
    const params: unknown[] = [filter.id ?? null, filter.displayName ?? null, filter.externalId ?? null];
    const where = `deleted_at is null and ($1::uuid is null or id = $1) and ($2::text is null or lower(display_name) = lower($2))
      and ($3::text is null or external_id = $3)`;
    const total = await db.query(`select count(*)::int as n from iam.scim_groups where ${where}`, params);
    const { rows } = await db.query(
      `select ${scimGroupTable.select} from iam.scim_groups where ${where} order by created_at, id offset $4 limit $5`, [...params, offset, limit]);
    return { total: (total.rows[0] as { n: number }).n, groups: rows as ScimGroup[] };
  },

  /** A live group, locked for a change of its members. */
  async findLiveForUpdate(db: Queryable, id: string): Promise<ScimGroup | undefined> {
    const { rows } = await db.query(`select ${scimGroupTable.select} from iam.scim_groups where id = $1 and deleted_at is null for update`, [id]);
    return rows[0] as ScimGroup | undefined;
  },

  async markDeleted(db: Queryable, id: string): Promise<void> {
    await db.query('update iam.scim_groups set deleted_at = now() where id = $1 and deleted_at is null', [id]);
  },

  /** Every live group with its member count, for the admin's mapping screen. */
  async listWithCounts(db: Queryable, limit: number): Promise<(ScimGroup & { memberCount: number })[]> {
    const { rows } = await db.query(
      `select ${scimGroupTable.select.split(', ').map((c) => `g.${c}`).join(', ')},
              (select count(*)::int from iam.scim_group_members m where m.group_id = g.id) as "memberCount"
         from iam.scim_groups g where g.deleted_at is null order by g.display_name, g.id limit $1`, [limit]);
    return rows as (ScimGroup & { memberCount: number })[];
  },
};
