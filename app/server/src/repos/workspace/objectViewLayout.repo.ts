// Data access for workspace.object_view_layouts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  objectViewLayoutTable,
  type NewObjectViewLayout,
  type ObjectViewLayout,
  type ObjectViewLayoutChanges,
} from '../../models/workspace/objectViewLayout.model.ts';

export const objectViewLayoutRepo = {
  insert(db: Queryable, row: NewObjectViewLayout): Promise<ObjectViewLayout> {
    return insertRow(db, objectViewLayoutTable, row);
  },

  findById(db: Queryable, id: ObjectViewLayout['id']): Promise<ObjectViewLayout | undefined> {
    return findRow(db, objectViewLayoutTable, { id });
  },

  update(
    db: Queryable,
    id: ObjectViewLayout['id'],
    changes: ObjectViewLayoutChanges,
  ): Promise<ObjectViewLayout | undefined> {
    return updateRow(db, objectViewLayoutTable, { id }, changes);
  },

  /** The type's active layout (one per type, a partial unique index), locked when asked. */
  async activeFor(db: Queryable, objectTypeId: string, forUpdate = false): Promise<ObjectViewLayout | undefined> {
    const { rows } = await db.query(
      `select ${objectViewLayoutTable.select} from workspace.object_view_layouts where object_type_id = $1 and status = 'active'
       ${forUpdate ? 'for update' : ''}`, [objectTypeId]);
    return rows[0] as ObjectViewLayout | undefined;
  },

  /**
   * Custom layouts that apply now, or were broken by an ontology change and not yet replaced for
   * their type, with the app and version each comes from; the most recently changed first.
   */
  async customInForce(db: Queryable, limit = 500): Promise<(ObjectViewLayout & { appId: string; version: number })[]> {
    const { rows } = await db.query(
      `select ${objectViewLayoutTable.select.split(', ').map((c) => `l.${c}`).join(', ')}, v.app_id as "appId", v.version as "version"
       from workspace.object_view_layouts l join workspace.app_versions v on v.id = l.app_version_id
       where not l.generated and (l.status = 'active' or (l.status = 'invalid' and not exists (
         select 1 from workspace.object_view_layouts a where a.object_type_id = l.object_type_id and a.status = 'active' and not a.generated)))
       order by l.updated_at desc, l.id limit $1`, [limit]);
    return rows as (ObjectViewLayout & { appId: string; version: number })[];
  },

  /** The active layouts a Studio app's versions hold (archiving the app retires them). */
  async activeForApp(db: Queryable, appId: string): Promise<ObjectViewLayout[]> {
    const { rows } = await db.query(
      `select ${objectViewLayoutTable.select} from workspace.object_view_layouts l
       where l.status = 'active' and l.app_version_id in (select v.id from workspace.app_versions v where v.app_id = $1)`, [appId]);
    return rows as ObjectViewLayout[];
  },
};
