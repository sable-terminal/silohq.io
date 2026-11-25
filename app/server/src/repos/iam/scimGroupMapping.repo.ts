// Data access for iam.scim_group_mappings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  scimGroupMappingTable,
  type NewScimGroupMapping,
  type ScimGroupMapping,
  type ScimGroupMappingChanges,
} from '../../models/iam/scimGroupMapping.model.ts';

export const scimGroupMappingRepo = {
  insert(db: Queryable, row: NewScimGroupMapping): Promise<ScimGroupMapping> {
    return insertRow(db, scimGroupMappingTable, row);
  },

  findById(db: Queryable, id: ScimGroupMapping['id']): Promise<ScimGroupMapping | undefined> {
    return findRow(db, scimGroupMappingTable, { id });
  },

  update(
    db: Queryable,
    id: ScimGroupMapping['id'],
    changes: ScimGroupMappingChanges,
  ): Promise<ScimGroupMapping | undefined> {
    return updateRow(db, scimGroupMappingTable, { id }, changes);
  },

  /** Live mappings, oldest first. */
  async listLive(db: Queryable): Promise<ScimGroupMapping[]> {
    const { rows } = await db.query(`select ${scimGroupMappingTable.select} from iam.scim_group_mappings where removed_at is null order by created_at, id`);
    return rows as ScimGroupMapping[];
  },

  /** The live mapping of a group to a role at a scope, if there is one. */
  async findLiveFor(db: Queryable, groupId: string, roleId: string, scopeId: string | null): Promise<ScimGroupMapping | undefined> {
    const { rows } = await db.query(
      `select ${scimGroupMappingTable.select} from iam.scim_group_mappings
        where group_id = $1 and role_id = $2 and scope_id is not distinct from $3 and removed_at is null`, [groupId, roleId, scopeId]);
    return rows[0] as ScimGroupMapping | undefined;
  },

  /** What a member should hold through their live groups' live mappings, oldest mapping first. */
  async desiredForMembership(db: Queryable, membershipId: string)
    : Promise<{ mappingId: string; roleId: string; scopeId: string | null; createdBy: string }[]> {
    const { rows } = await db.query(
      `select mp.id as "mappingId", mp.role_id as "roleId", mp.scope_id as "scopeId", mp.created_by as "createdBy"
         from iam.scim_group_members gm
         join iam.scim_groups g on g.id = gm.group_id and g.deleted_at is null
         join iam.scim_group_mappings mp on mp.group_id = gm.group_id and mp.removed_at is null
         join iam.roles r on r.id = mp.role_id and r.retired_at is null
        where gm.membership_id = $1
        order by mp.created_at, mp.id`, [membershipId]);
    return rows as { mappingId: string; roleId: string; scopeId: string | null; createdBy: string }[];
  },

  /** Ends a mapping once. */
  async remove(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'update iam.scim_group_mappings set removed_at = now(), removed_by = $2 where id = $1 and removed_at is null', [id, membershipId]);
    return rowCount === 1;
  },
};
