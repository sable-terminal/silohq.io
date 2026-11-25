// Data access for fleet.releases, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import { releaseTable, type NewRelease, type Release } from '../../models/fleet/release.model.ts';

export const releaseRepo = {
  insert(db: Queryable, row: NewRelease): Promise<Release> {
    return insertRow(db, releaseTable, row);
  },

  findByReleaseId(db: Queryable, releaseId: Release['releaseId']): Promise<Release | undefined> {
    return findRow(db, releaseTable, { releaseId });
  },

  /** Releases still in play: a channel's head, one with a promotion pending, or one registered since. */
  async live(db: Queryable, registeredSince: string): Promise<string[]> {
    const { rows } = await db.query(
      `select r.release_id as "releaseId" from fleet.releases r
        where r.registered_at >= $1
           or exists (select 1 from fleet.promotions p where p.release_id = r.release_id and p.state = 'pending')
           or r.release_id in (select distinct on (channel) release_id from fleet.channel_heads order by channel, sequence desc)
        order by r.release_id`, [registeredSince]);
    return (rows as { releaseId: string }[]).map((r) => r.releaseId);
  },
};
