// Data access for files.media_set_shares, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mediaSetShareTable,
  type MediaSetShare,
  type MediaSetShareChanges,
  type NewMediaSetShare,
} from '../../models/files/mediaSetShare.model.ts';

export const mediaSetShareRepo = {
  insert(db: Queryable, row: NewMediaSetShare): Promise<MediaSetShare> {
    return insertRow(db, mediaSetShareTable, row);
  },

  findById(db: Queryable, id: MediaSetShare['id']): Promise<MediaSetShare | undefined> {
    return findRow(db, mediaSetShareTable, { id });
  },

  update(
    db: Queryable,
    id: MediaSetShare['id'],
    changes: MediaSetShareChanges,
  ): Promise<MediaSetShare | undefined> {
    return updateRow(db, mediaSetShareTable, { id }, changes);
  },

  /** The live shares of a set that reach a member: theirs, a scope whose subtree holds one of theirs, or the organisation. */
  async liveReaching(db: Queryable, setId: string, membershipId: string, scopePaths: readonly string[]): Promise<MediaSetShare[]> {
    const { rows } = await db.query(
      `select ${mediaSetShareTable.select.split(',').map((c) => `s.${c.trim()}`).join(', ')} from files.media_set_shares s
       left join iam.scopes sc on sc.organisation_id = s.organisation_id and sc.id = s.grantee_scope_id
       where s.media_set_id = $1 and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and (s.grantee_membership_id = $2 or s.grantee_whole_organisation
              or (sc.id is not null and exists (select 1 from unnest($3::text[]) as p where p::ltree <@ sc.path)))`,
      [setId, membershipId, [...scopePaths]]);
    return rows as MediaSetShare[];
  },

  /** The sets a live share reaches this member through. */
  async setsReaching(db: Queryable, membershipId: string, scopePaths: readonly string[]): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct s.media_set_id as id from files.media_set_shares s
       left join iam.scopes sc on sc.organisation_id = s.organisation_id and sc.id = s.grantee_scope_id
       where s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
         and (s.grantee_membership_id = $1 or s.grantee_whole_organisation
              or (sc.id is not null and exists (select 1 from unnest($2::text[]) as p where p::ltree <@ sc.path)))`,
      [membershipId, [...scopePaths]]);
    return rows.map((r) => r.id as string);
  },

  async listForSet(db: Queryable, setId: string): Promise<MediaSetShare[]> {
    const { rows } = await db.query(`select ${mediaSetShareTable.select} from files.media_set_shares where media_set_id = $1 order by created_at, id`, [setId]);
    return rows as MediaSetShare[];
  },
};
