// Data access for files.media_links, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mediaLinkTable,
  type MediaLink,
  type MediaLinkChanges,
  type NewMediaLink,
} from '../../models/files/mediaLink.model.ts';

export const mediaLinkRepo = {
  insert(db: Queryable, row: NewMediaLink): Promise<MediaLink> {
    return insertRow(db, mediaLinkTable, row);
  },

  findById(db: Queryable, id: MediaLink['id']): Promise<MediaLink | undefined> {
    return findRow(db, mediaLinkTable, { id });
  },

  update(db: Queryable, id: MediaLink['id'], changes: MediaLinkChanges): Promise<MediaLink | undefined> {
    return updateRow(db, mediaLinkTable, { id }, changes);
  },

  /** A live link, or nothing where one already joins this item and object (a rule applied again). */
  async insertOnce(db: Queryable, row: NewMediaLink): Promise<MediaLink | undefined> {
    const { rows } = await db.query(
      `insert into files.media_links (id, organisation_id, media_item_id, object_type_id, object_id, made_by, linked_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (organisation_id, media_item_id, object_type_id, object_id) where removed_at is null do nothing
       returning ${mediaLinkTable.select}`,
      [row.id, row.organisationId, row.mediaItemId, row.objectTypeId, row.objectId, row.madeBy, row.linkedBy]);
    return rows[0] as MediaLink | undefined;
  },

  async listLiveForItems(db: Queryable, itemIds: readonly string[]): Promise<MediaLink[]> {
    if (itemIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${mediaLinkTable.select} from files.media_links where media_item_id = any($1::uuid[]) and removed_at is null order by linked_at, id`, [[...itemIds]]);
    return rows as MediaLink[];
  },

  /** The live items linked to an object, newest link first, each with its set and its upload's name. */
  async listForObject(db: Queryable, objectTypeId: string, objectId: string, limit: number)
    : Promise<{ linkId: string; itemId: string; mediaSetId: string; fileName: string }[]> {
    const { rows } = await db.query(
      `select l.id as "linkId", i.id as "itemId", i.media_set_id as "mediaSetId", f.name as "fileName"
       from files.media_links l
       join files.media_items i on i.organisation_id = l.organisation_id and i.id = l.media_item_id and i.removed_at is null
       join files.files f on f.organisation_id = i.organisation_id and f.id = i.file_id and f.status = 'available'
       where l.object_type_id = $1 and l.object_id = $2 and l.removed_at is null
       order by l.linked_at desc, l.id desc limit $3`, [objectTypeId, objectId, limit]);
    return rows as { linkId: string; itemId: string; mediaSetId: string; fileName: string }[];
  },
};
