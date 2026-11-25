// Data access for workspace.ai_agents, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  aiAgentTable,
  type AiAgent,
  type AiAgentChanges,
  type NewAiAgent,
} from '../../models/workspace/aiAgent.model.ts';

export const aiAgentRepo = {
  insert(db: Queryable, row: NewAiAgent): Promise<AiAgent> {
    return insertRow(db, aiAgentTable, row);
  },

  findById(db: Queryable, id: AiAgent['id']): Promise<AiAgent | undefined> {
    return findRow(db, aiAgentTable, { id });
  },

  update(db: Queryable, id: AiAgent['id'], changes: AiAgentChanges): Promise<AiAgent | undefined> {
    return updateRow(db, aiAgentTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<AiAgent | undefined> {
    const { rows } = await db.query(`select ${aiAgentTable.select} from workspace.ai_agents where id = $1 for update`, [id]);
    return rows[0] as AiAgent | undefined;
  },

  /** A member's own AI agents, newest change first; archived ones only when asked for. */
  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<AiAgent[]> {
    const { rows } = await db.query(
      `select ${aiAgentTable.select} from workspace.ai_agents where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as AiAgent[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<AiAgent[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${aiAgentTable.select} from workspace.ai_agents where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as AiAgent[];
  },
};
