// Data access for fleet.advisory_feeds, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  advisoryFeedTable,
  type AdvisoryFeed,
  type AdvisoryFeedChanges,
  type NewAdvisoryFeed,
} from '../../models/fleet/advisoryFeed.model.ts';

export const advisoryFeedRepo = {
  insert(db: Queryable, row: NewAdvisoryFeed): Promise<AdvisoryFeed> {
    return insertRow(db, advisoryFeedTable, row);
  },

  findByFeed(db: Queryable, feed: AdvisoryFeed['feed']): Promise<AdvisoryFeed | undefined> {
    return findRow(db, advisoryFeedTable, { feed });
  },

  update(
    db: Queryable,
    feed: AdvisoryFeed['feed'],
    changes: AdvisoryFeedChanges,
  ): Promise<AdvisoryFeed | undefined> {
    return updateRow(db, advisoryFeedTable, { feed }, changes);
  },

  /** The feed's lease, taken unless another replica holds one still running; undefined when it does. */
  async claim(db: Queryable, feed: string, now: string, until: string): Promise<AdvisoryFeed | undefined> {
    const { rows } = await db.query(
      `insert into fleet.advisory_feeds (feed, lease_until) values ($1, $3)
       on conflict (feed) do update set lease_until = excluded.lease_until
       where fleet.advisory_feeds.lease_until is null or fleet.advisory_feeds.lease_until < $2
       returning ${advisoryFeedTable.select}`, [feed, now, until]);
    return rows[0] as AdvisoryFeed | undefined;
  },

  /** A sync done: how far it reached, the lease given back. The advisories the feed now holds. */
  async finish(db: Queryable, feed: string, done: { syncedThrough: string; lastSyncedAt: string }): Promise<number> {
    const { rows } = await db.query(
      `update fleet.advisory_feeds set synced_through = $2, last_synced_at = $3, last_error = null, lease_until = null,
              advisories = (select count(*) from fleet.advisories where feed = $1)
        where feed = $1 returning advisories`, [feed, done.syncedThrough, done.lastSyncedAt]);
    return (rows[0] as { advisories: number } | undefined)?.advisories ?? 0;
  },

  /** A sync failed: why, the lease given back; what it held stays. */
  async fail(db: Queryable, feed: string, error: string): Promise<void> {
    await db.query('update fleet.advisory_feeds set last_error = $2, lease_until = null where feed = $1', [feed, error]);
  },

  async forFeeds(db: Queryable, feeds: readonly string[]): Promise<AdvisoryFeed[]> {
    const { rows } = await db.query(`select ${advisoryFeedTable.select} from fleet.advisory_feeds where feed = any($1::text[]) order by feed`, [feeds]);
    return rows as AdvisoryFeed[];
  },
};
