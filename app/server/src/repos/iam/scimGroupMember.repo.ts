// Data access for iam.scim_group_members, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  scimGroupMemberTable,
  type NewScimGroupMember,
  type ScimGroupMember,
} from '../../models/iam/scimGroupMember.model.ts';

export const scimGroupMemberRepo = {
  insert(db: Queryable, row: NewScimGroupMember): Promise<ScimGroupMember> {
    return insertRow(db, scimGroupMemberTable, row);
  },

  findById(db: Queryable, id: ScimGroupMember['id']): Promise<ScimGroupMember | undefined> {
    return findRow(db, scimGroupMemberTable, { id });
  },

  findByGroupIdAndMembershipId(
    db: Queryable,
    key: Pick<ScimGroupMember, 'organisationId' | 'groupId' | 'membershipId'>,
  ): Promise<ScimGroupMember | undefined> {
    return findRow(db, scimGroupMemberTable, key);
  },

  remove(db: Queryable, id: ScimGroupMember['id']): Promise<boolean> {
    return deleteRow(db, scimGroupMemberTable, { id });
  },

  /** The group's members' membership ids, in a stable order. */
  async membersOf(db: Queryable, groupId: string): Promise<string[]> {
    const { rows } = await db.query('select membership_id from iam.scim_group_members where group_id = $1 order by added_at, membership_id', [groupId]);
    return rows.map((r) => (r as { membership_id: string }).membership_id);
  },

  /** Adds members; those already in it are unchanged. The ones newly added. */
  async add(db: Queryable, organisationId: string, groupId: string, membershipIds: readonly string[], ids: readonly string[]): Promise<string[]> {
    if (membershipIds.length === 0) return [];
    const { rows } = await db.query(
      `insert into iam.scim_group_members (id, organisation_id, group_id, membership_id)
       select i, $1, $2, m from unnest($3::uuid[], $4::uuid[]) as t(i, m)
       on conflict (organisation_id, group_id, membership_id) do nothing
       returning membership_id`, [organisationId, groupId, ids, membershipIds]);
    return rows.map((r) => (r as { membership_id: string }).membership_id);
  },

  /** Removes members (all of them when membershipIds is undefined). The ones removed. */
  async removeMembers(db: Queryable, groupId: string, membershipIds?: readonly string[]): Promise<string[]> {
    const { rows } = await db.query(
      `delete from iam.scim_group_members where group_id = $1 and ($2::uuid[] is null or membership_id = any($2)) returning membership_id`,
      [groupId, membershipIds ?? null]);
    return rows.map((r) => (r as { membership_id: string }).membership_id);
  },
};
