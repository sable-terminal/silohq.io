// Data access for workspace.saved_views, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  savedViewTable,
  type NewSavedView,
  type SavedView,
  type SavedViewChanges,
} from '../../models/workspace/savedView.model.ts';

/** The scopes containing one of member $1's active scopes (a scope share reaches its whole subtree). */
export const SCOPES_CONTAINING_MEMBER = `select sc.id from iam.scope_memberships sm
  join iam.scopes mine on mine.organisation_id = sm.organisation_id and mine.id = sm.scope_id
  join iam.scopes sc on sc.organisation_id = mine.organisation_id and mine.path <@ sc.path
  where sm.membership_id = $1 and sm.inactive_since is null`;

/** A table's select list with each column qualified by a join alias. */
const qualified = (alias: string, select: string): string => select.split(', ').map((column) => `${alias}.${column}`).join(', ');

export const savedViewRepo = {
  insert(db: Queryable, row: NewSavedView): Promise<SavedView> {
    return insertRow(db, savedViewTable, row);
  },

  findById(db: Queryable, id: SavedView['id']): Promise<SavedView | undefined> {
    return findRow(db, savedViewTable, { id });
  },

  findByThreadId(
    db: Queryable,
    key: Pick<SavedView, 'organisationId' | 'threadId'>,
  ): Promise<SavedView | undefined> {
    return findRow(db, savedViewTable, key);
  },

  update(db: Queryable, id: SavedView['id'], changes: SavedViewChanges): Promise<SavedView | undefined> {
    return updateRow(db, savedViewTable, { id }, changes);
  },

  /** The row, locked for the rest of the transaction. */
  async findForUpdate(db: Queryable, id: SavedView['id']): Promise<SavedView | undefined> {
    const { rows } = await db.query(`select ${savedViewTable.select} from workspace.saved_views where id = $1 for update`, [id]);
    return rows[0] as SavedView | undefined;
  },

  /** A member's own views, newest first. The name filter matches the owner's own label. */
  async listOwned(db: Queryable, ownerId: string, filter: { archived: boolean; favouritedOnly: boolean; search?: string | undefined; limit: number })
    : Promise<SavedView[]> {
    const { rows } = await db.query(
      `select ${savedViewTable.select} from workspace.saved_views
       where owner_membership_id = $1 and ((archived_at is not null) = $2) and (not $3 or favourited)
         and ($4::text is null or strpos(lower(name), lower($4)) > 0)
       order by created_at desc, id desc limit $5`,
      [ownerId, filter.archived, filter.favouritedOnly, filter.search ?? null, filter.limit]);
    return rows as SavedView[];
  },

  /** Every live view a member owns, locked: what a transfer moves. */
  async ownedLiveForUpdate(db: Queryable, ownerId: string): Promise<SavedView[]> {
    const { rows } = await db.query(
      `select ${savedViewTable.select} from workspace.saved_views where owner_membership_id = $1 and archived_at is null
       order by created_at for update`, [ownerId]);
    return rows as SavedView[];
  },

  /**
   * Live views shared with a member by someone else, one row per share that reaches them: a
   * share to the membership, to a scope containing one of its active scopes, or to the
   * organisation. Revoked, suspended and expired shares never appear. The sharing policy is
   * applied by the caller, at resolution.
   */
  async listSharedWith(db: Queryable, membershipId: string, filter: { search?: string | undefined; limit: number })
    : Promise<(SavedView & { shareId: string; shareAccess: 'view' | 'run' | 'copy'; shareKind: 'membership' | 'scope' | 'organisation'; shareScopeId: string | null })[]> {
    const { rows } = await db.query(
      `select ${qualified('v', savedViewTable.select)}, s.id as "shareId", s.access as "shareAccess", s.scope_id as "shareScopeId",
              case when s.membership_id is not null then 'membership' when s.scope_id is not null then 'scope' else 'organisation' end as "shareKind"
       from workspace.view_shares s
       join workspace.saved_views v on v.organisation_id = s.organisation_id and v.id = s.saved_view_id
       where s.saved_view_id is not null and s.revoked_at is null and s.suspended_at is null
         and (s.expires_at is null or s.expires_at > now())
         and v.archived_at is null and v.owner_membership_id <> $1
         and ($2::text is null or strpos(lower(v.name), lower($2)) > 0)
         and (s.membership_id = $1 or s.organisation_wide
              or s.scope_id in (${SCOPES_CONTAINING_MEMBER}))
       order by v.created_at desc, v.id desc limit $3`,
      [membershipId, filter.search ?? null, filter.limit * 4]);
    return rows as (SavedView & { shareId: string; shareAccess: 'view' | 'run' | 'copy'; shareKind: 'membership' | 'scope' | 'organisation'; shareScopeId: string | null })[];
  },
};
