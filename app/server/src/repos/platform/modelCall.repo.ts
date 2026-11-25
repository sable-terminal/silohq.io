// Data access for platform.model_calls, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_audit_writer, silo_report; written by silo_audit_writer.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  modelCallTable,
  type ModelCall,
  type ModelCallPrimaryKey,
  type NewModelCall,
} from '../../models/platform/modelCall.model.ts';

export const modelCallRepo = {
  insert(db: Queryable, row: NewModelCall): Promise<ModelCall> {
    return insertRow(db, modelCallTable, row);
  },

  findByKey(db: Queryable, key: ModelCallPrimaryKey): Promise<ModelCall | undefined> {
    return findRow(db, modelCallTable, key);
  },

  findByCallIdAndOccurredAt(
    db: Queryable,
    key: Pick<ModelCall, 'organisationId' | 'callId' | 'occurredAt'>,
  ): Promise<ModelCall | undefined> {
    return findRow(db, modelCallTable, key);
  },

  // Every call of one request (a compile, an FDE task), oldest first: the measured cost of
  // that request (spec 7.8). Uses model_calls_by_correlation.
  async listByCorrelation(db: Queryable, organisationId: string, correlationId: string): Promise<ModelCall[]> {
    const { rows } = await db.query(
      `select ${modelCallTable.select} from ${modelCallTable.sql}
       where organisation_id = $1 and correlation_id = $2 order by occurred_at, id limit 1000`,
      [organisationId, correlationId]);
    return rows as ModelCall[];
  },

  /**
   * Across the cell: compiles logged, and of the most recent `limit` the mean tokens, how many
   * were priced at their route's prices and their mean cost (counts and figures only; 74.7).
   */
  async compileSample(db: Queryable, limit: number)
    : Promise<{ logged: number; sampled: number; meanTokens: number | null; priced: number; meanCost: number | null }> {
    const { rows } = await db.query(
      `select logged::int, sampled::int, mean_tokens::float8 as "meanTokens", priced::int, mean_cost::float8 as "meanCost"
       from platform.compile_call_sample($1)`, [limit]);
    return rows[0] as { logged: number; sampled: number; meanTokens: number | null; priced: number; meanCost: number | null };
  },

  /** An AI FDE engagement's model calls: how many, how many were priced, and what those cost (73.5). */
  async engagementCost(db: Queryable, engagementId: string): Promise<{ calls: number; priced: number; cost: string }> {
    const { rows } = await db.query(
      `select count(*)::int as calls, count(provider_cost)::int as priced, coalesce(sum(provider_cost), 0)::numeric(14,8)::text as cost
       from ${modelCallTable.sql} where engagement_id = $1 and outcome <> 'refused'`, [engagementId]);
    return rows[0] as { calls: number; priced: number; cost: string };
  },
};
