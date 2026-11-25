// Data access for files.media_items, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mediaItemTable,
  type MediaItem,
  type MediaItemChanges,
  type NewMediaItem,
} from '../../models/files/mediaItem.model.ts';

export const mediaItemRepo = {
  insert(db: Queryable, row: NewMediaItem): Promise<MediaItem> {
    return insertRow(db, mediaItemTable, row);
  },

  findById(db: Queryable, id: MediaItem['id']): Promise<MediaItem | undefined> {
    return findRow(db, mediaItemTable, { id });
  },

  update(db: Queryable, id: MediaItem['id'], changes: MediaItemChanges): Promise<MediaItem | undefined> {
    return updateRow(db, mediaItemTable, { id }, changes);
  },

  /** Each set's items still in it whose upload is still in Files. */
  async countLive(db: Queryable, setIds: readonly string[]): Promise<Map<string, number>> {
    if (setIds.length === 0) return new Map();
    const { rows } = await db.query(
      `select mi.media_set_id as "setId", count(*)::int as n from files.media_items mi
       join files.files f on f.organisation_id = mi.organisation_id and f.id = mi.file_id
       where mi.media_set_id = any($1::uuid[]) and mi.removed_at is null and f.status = 'available' group by mi.media_set_id`, [[...setIds]]);
    return new Map(rows.map((r) => [r.setId as string, r.n as number]));
  },

  /** A page of a set's items, newest first, each with its upload's name; after an item, of a kind. */
  async page(db: Queryable, setId: string, input: { kind?: MediaItem['kind'] | undefined; after?: string | undefined; limit: number })
    : Promise<{ item: MediaItem; name: string }[]> {
    const { rows } = await db.query(
      `select ${mediaItemTable.select.split(',').map((c) => `mi.${c.trim()}`).join(', ')}, f.name as "fileName"
       from files.media_items mi join files.files f on f.organisation_id = mi.organisation_id and f.id = mi.file_id
       where mi.media_set_id = $1 and mi.removed_at is null and f.status = 'available' and ($2::text is null or mi.kind = $2)
         and ($3::uuid is null or (mi.added_at, mi.id) < (select a.added_at, a.id from files.media_items a where a.id = $3))
       order by mi.added_at desc, mi.id desc limit $4`,
      [setId, input.kind ?? null, input.after ?? null, input.limit]);
    return rows.map(({ fileName, ...item }) => ({ item: item as MediaItem, name: fileName as string }));
  },
};
