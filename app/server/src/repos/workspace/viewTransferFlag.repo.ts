// Data access for workspace.view_transfer_flags, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  viewTransferFlagTable,
  type NewViewTransferFlag,
  type ViewTransferFlag,
  type ViewTransferFlagChanges,
} from '../../models/workspace/viewTransferFlag.model.ts';

export const viewTransferFlagRepo = {
  insert(db: Queryable, row: NewViewTransferFlag): Promise<ViewTransferFlag> {
    return insertRow(db, viewTransferFlagTable, row);
  },

  findById(db: Queryable, id: ViewTransferFlag['id']): Promise<ViewTransferFlag | undefined> {
    return findRow(db, viewTransferFlagTable, { id });
  },

  update(
    db: Queryable,
    id: ViewTransferFlag['id'],
    changes: ViewTransferFlagChanges,
  ): Promise<ViewTransferFlag | undefined> {
    return updateRow(db, viewTransferFlagTable, { id }, changes);
  },

  /** The open flags of views a member inherited, oldest first: their review queue. */
  async listOpenFor(db: Queryable, membershipId: string): Promise<ViewTransferFlag[]> {
    const { rows } = await db.query(
      `select ${viewTransferFlagTable.select} from workspace.view_transfer_flags
       where transferred_to = $1 and reviewed_at is null and saved_view_id is not null order by created_at, id`, [membershipId]);
    return rows as ViewTransferFlag[];
  },

  async findOpenForView(db: Queryable, viewId: string): Promise<ViewTransferFlag | undefined> {
    const { rows } = await db.query(
      `select ${viewTransferFlagTable.select} from workspace.view_transfer_flags where saved_view_id = $1 and reviewed_at is null`, [viewId]);
    return rows[0] as ViewTransferFlag | undefined;
  },

  /**
   * The admin a member's views go to on removal (spec 37.7), per scope the member belonged
   * to (active, or made inactive by the removal): for each, the nearest admin above it,
   * an active membership other than the member holding a live role with admin.delegate on
   * a scope whose path contains it. Deepest first per scope; the caller applies the rule
   * across scopes.
   */
  async nearestAdmins(db: Queryable, membershipId: string): Promise<{ scopeId: string; isPrimary: boolean; adminId: string; depth: number }[]> {
    const { rows } = await db.query(
      `select distinct on (sm.scope_id) sm.scope_id as "scopeId", sm.is_primary as "isPrimary", ra.membership_id as "adminId",
              nlevel(a.path) as depth
       from iam.scope_memberships sm
       join iam.memberships gone on gone.organisation_id = sm.organisation_id and gone.id = sm.membership_id
       join iam.scopes s on s.organisation_id = sm.organisation_id and s.id = sm.scope_id
       join iam.role_assignments ra on ra.organisation_id = sm.organisation_id and ra.on_scope_id is not null
       join iam.scopes a on a.organisation_id = ra.organisation_id and a.id = ra.on_scope_id and s.path <@ a.path
       join iam.role_permissions rp on rp.organisation_id = ra.organisation_id and rp.role_id = ra.role_id
                                   and rp.permission_id = 'admin.delegate'
       join iam.memberships m on m.organisation_id = ra.organisation_id and m.id = ra.membership_id and m.status = 'active'
       where sm.membership_id = $1 and ra.membership_id <> $1
         and (sm.inactive_since is null or sm.inactive_since >= coalesce(gone.removed_at, gone.suspended_at, sm.inactive_since))
         and ra.revoked_at is null and ra.silenced_at is null and (ra.expires_at is null or ra.expires_at > now())
       order by sm.scope_id, nlevel(a.path) desc, ra.granted_at, ra.membership_id`, [membershipId]);
    return rows.map((r) => ({ ...(r as { scopeId: string; isPrimary: boolean; adminId: string }), depth: Number((r as { depth: number }).depth) }));
  },

  /** A super admin other than the member, active, longest held: the receiver where no scope admin applies. */
  async aSuperAdmin(db: Queryable, membershipId: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select ra.membership_id as "adminId" from iam.role_assignments ra
       join iam.roles r on r.organisation_id = ra.organisation_id and r.id = ra.role_id and r.system_role and r.name = 'Super admin'
       join iam.memberships m on m.organisation_id = ra.organisation_id and m.id = ra.membership_id and m.status = 'active'
       where ra.membership_id <> $1 and ra.on_scope_id is null and ra.revoked_at is null and ra.silenced_at is null
         and (ra.expires_at is null or ra.expires_at > now())
       order by ra.granted_at, ra.membership_id limit 1`, [membershipId]);
    return (rows[0] as { adminId: string } | undefined)?.adminId;
  },
};
