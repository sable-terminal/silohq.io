// Data access for fleet.channel_heads, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  channelHeadTable,
  type ChannelHead,
  type ChannelHeadPrimaryKey,
  type NewChannelHead,
} from '../../models/fleet/channelHead.model.ts';

export const channelHeadRepo = {
  insert(db: Queryable, row: NewChannelHead): Promise<ChannelHead> {
    return insertRow(db, channelHeadTable, row);
  },

  findByKey(db: Queryable, key: ChannelHeadPrimaryKey): Promise<ChannelHead | undefined> {
    return findRow(db, channelHeadTable, key);
  },

  findByPromotionId(
    db: Queryable,
    promotionId: ChannelHead['promotionId'],
  ): Promise<ChannelHead | undefined> {
    return findRow(db, channelHeadTable, { promotionId });
  },

  /** The channel's current head: its highest sequence. */
  async latest(db: Queryable, channel: ChannelHead['channel']): Promise<ChannelHead | undefined> {
    const { rows } = await db.query(
      `select ${channelHeadTable.select} from fleet.channel_heads where channel = $1 order by sequence desc limit 1`, [channel]);
    return rows[0] as ChannelHead | undefined;
  },

  /** Each time a release was a channel's head, with how that head's rollout went (null: no rollout). */
  async historyOf(db: Queryable, channel: ChannelHead['channel'], releaseId: ChannelHead['releaseId'])
    : Promise<{ promotedAt: string; rolloutStatus: 'running' | 'halted' | 'completed' | 'superseded' | null }[]> {
    const { rows } = await db.query(
      `select h.promoted_at as "promotedAt", r.status as "rolloutStatus"
         from fleet.channel_heads h left join fleet.rollouts r on r.id = h.rollout_id
        where h.channel = $1 and h.release_id = $2 order by h.sequence`, [channel, releaseId]);
    return rows as { promotedAt: string; rolloutStatus: 'running' | 'halted' | 'completed' | 'superseded' | null }[];
  },
};
