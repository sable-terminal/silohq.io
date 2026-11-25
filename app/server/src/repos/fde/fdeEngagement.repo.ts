// Data access for fde.fde_engagements, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeEngagementTable,
  type FdeEngagement,
  type FdeEngagementChanges,
  type NewFdeEngagement,
} from '../../models/fde/fdeEngagement.model.ts';

export const fdeEngagementRepo = {
  insert(db: Queryable, row: NewFdeEngagement): Promise<FdeEngagement> {
    return insertRow(db, fdeEngagementTable, row);
  },

  findById(db: Queryable, id: FdeEngagement['id']): Promise<FdeEngagement | undefined> {
    return findRow(db, fdeEngagementTable, { id });
  },

  update(
    db: Queryable,
    id: FdeEngagement['id'],
    changes: FdeEngagementChanges,
  ): Promise<FdeEngagement | undefined> {
    return updateRow(db, fdeEngagementTable, { id }, changes);
  },

  // Adds charged tokens to the engagement's running total, in the transaction of the ledger
  // row, only within its token budget (metering; design: tokens_consumed). Undefined when the
  // charge would pass the budget or the engagement is not running.
  async addTokensConsumed(db: Queryable, id: string, tokens: number): Promise<{ tokensConsumed: string; tokenBudget: string } | undefined> {
    const { rows } = await db.query(
      `update fde.fde_engagements set tokens_consumed = tokens_consumed + $2
        where id = $1 and status = 'active' and tokens_consumed + $2 <= token_budget
       returning tokens_consumed::text as "tokensConsumed", token_budget::text as "tokenBudget"`, [id, tokens]);
    return rows[0] as { tokensConsumed: string; tokenBudget: string } | undefined;
  },

  async listForOrganisation(db: Queryable, organisationId: string): Promise<FdeEngagement[]> {
    const { rows } = await db.query(
      `select ${fdeEngagementTable.select} from fde.fde_engagements where organisation_id = $1 order by created_at desc limit 100`, [organisationId]);
    return rows as FdeEngagement[];
  },

  /** Active engagements across organisations, for the orchestrator's sweep (fde.engagements_to_run). */
  async toRun(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from fde.engagements_to_run($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** Adds provider cost; refused (undefined) past the budget, as the token total is. */
  async addProviderCost(db: Queryable, id: string, pounds: string): Promise<{ consumed: string; budget: string } | undefined> {
    const { rows } = await db.query(
      `update fde.fde_engagements set provider_cost_consumed = provider_cost_consumed + $2::numeric
        where id = $1 and provider_cost_consumed + $2::numeric <= provider_cost_budget
       returning provider_cost_consumed::text as consumed, provider_cost_budget::text as budget`, [id, pounds]);
    return rows[0] as { consumed: string; budget: string } | undefined;
  },
};
