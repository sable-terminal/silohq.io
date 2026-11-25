// Data access for connect.agent_pools, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  agentPoolTable,
  type AgentPool,
  type AgentPoolChanges,
  type NewAgentPool,
} from '../../models/connect/agentPool.model.ts';

export const agentPoolRepo = {
  insert(db: Queryable, row: NewAgentPool): Promise<AgentPool> {
    return insertRow(db, agentPoolTable, row);
  },

  findById(db: Queryable, id: AgentPool['id']): Promise<AgentPool | undefined> {
    return findRow(db, agentPoolTable, { id });
  },

  update(db: Queryable, id: AgentPool['id'], changes: AgentPoolChanges): Promise<AgentPool | undefined> {
    return updateRow(db, agentPoolTable, { id }, changes);
  },

  /** The pool, locked until the transaction ends: one of its agents at a time takes an update. */
  async lock(db: Queryable, id: string): Promise<AgentPool | undefined> {
    const { rows } = await db.query(`select ${agentPoolTable.select} from connect.agent_pools where id = $1 for update`, [id]);
    return rows[0] as AgentPool | undefined;
  },

  /** The organisation's live pools, newest first. */
  async listLive(db: Queryable): Promise<AgentPool[]> {
    const { rows } = await db.query(`select ${agentPoolTable.select} from connect.agent_pools where retired_at is null order by created_at desc, id`);
    return rows as AgentPool[];
  },
};
