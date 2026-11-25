// Data access for connect.agent_releases, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  agentReleaseTable,
  type AgentRelease,
  type NewAgentRelease,
} from '../../models/connect/agentRelease.model.ts';

export const agentReleaseRepo = {
  insert(db: Queryable, row: NewAgentRelease): Promise<AgentRelease> {
    return insertRow(db, agentReleaseTable, row);
  },

  findByReleaseId(db: Queryable, releaseId: AgentRelease['releaseId']): Promise<AgentRelease | undefined> {
    return findRow(db, agentReleaseTable, { releaseId });
  },

  findByChannelAndChannelSequence(
    db: Queryable,
    key: Pick<AgentRelease, 'channel' | 'channelSequence'>,
  ): Promise<AgentRelease | undefined> {
    return findRow(db, agentReleaseTable, key);
  },

  findByVersion(db: Queryable, version: AgentRelease['version']): Promise<AgentRelease | undefined> {
    return findRow(db, agentReleaseTable, { version });
  },

  /** Every release received, the newest head first. A cell keeps few. */
  async list(db: Queryable): Promise<AgentRelease[]> {
    const { rows } = await db.query(`select ${agentReleaseTable.select} from connect.agent_releases order by channel_sequence desc, release_id`);
    return rows as AgentRelease[];
  },
};
