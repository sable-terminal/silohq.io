// Data access for connect.agent_rollouts, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  agentRolloutTable,
  type AgentRollout,
  type AgentRolloutChanges,
  type NewAgentRollout,
} from '../../models/connect/agentRollout.model.ts';

export const agentRolloutRepo = {
  insert(db: Queryable, row: NewAgentRollout): Promise<AgentRollout> {
    return insertRow(db, agentRolloutTable, row);
  },

  findById(db: Queryable, id: AgentRollout['id']): Promise<AgentRollout | undefined> {
    return findRow(db, agentRolloutTable, { id });
  },

  findByReleaseId(db: Queryable, releaseId: AgentRollout['releaseId']): Promise<AgentRollout | undefined> {
    return findRow(db, agentRolloutTable, { releaseId });
  },

  update(
    db: Queryable,
    id: AgentRollout['id'],
    changes: AgentRolloutChanges,
  ): Promise<AgentRollout | undefined> {
    return updateRow(db, agentRolloutTable, { id }, changes);
  },

  /** The rollout running, locked until the transaction ends: one replica moves it at a time. */
  async lockRunning(db: Queryable): Promise<AgentRollout | undefined> {
    const { rows } = await db.query(`select ${agentRolloutTable.select} from connect.agent_rollouts where status = 'running' for update`);
    return rows[0] as AgentRollout | undefined;
  },

  /** The rollouts, newest first. */
  async list(db: Queryable, limit: number): Promise<AgentRollout[]> {
    const { rows } = await db.query(`select ${agentRolloutTable.select} from connect.agent_rollouts order by started_at desc, id desc limit $1`, [limit]);
    return rows as AgentRollout[];
  },

  /**
   * Agents of automatic pools in a wave that the rollout has to update or watch, across
   * organisations (connect.agent_wave_size): below its version, or come onto it since it began.
   */
  async waveSize(db: Queryable, wave: number, rollout: { version: string; major: number; minor: number; patch: number; since: string },
    firstOrganisations: readonly string[]): Promise<number> {
    const { rows } = await db.query('select connect.agent_wave_size($1::smallint, $2, $3, $4, $5, $6, $7::uuid[]) as size',
      [wave, rollout.version, rollout.major, rollout.minor, rollout.patch, rollout.since, firstOrganisations]);
    return (rows[0] as { size: number }).size;
  },

  /** The rollout's gates over the agents it reached, across organisations (connect.agent_rollout_health). Counts only. */
  async health(db: Queryable, input: { version: string; since: string; at: string; returnMinutes: number; minWork: number; maxFailedShare: number })
    : Promise<{ updated: number; stalled: number; silent: number; failing: number }> {
    const { rows } = await db.query('select updated, stalled, silent, failing from connect.agent_rollout_health($1, $2, $3, $4, $5, $6)',
      [input.version, input.since, input.at, input.returnMinutes, input.minWork, input.maxFailedShare]);
    return rows[0] as { updated: number; stalled: number; silent: number; failing: number };
  },
};
