// Data access for automation.automations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationTable,
  type Automation,
  type AutomationChanges,
  type NewAutomation,
} from '../../models/automation/automation.model.ts';

export const automationRepo = {
  insert(db: Queryable, row: NewAutomation): Promise<Automation> {
    return insertRow(db, automationTable, row);
  },

  findById(db: Queryable, id: Automation['id']): Promise<Automation | undefined> {
    return findRow(db, automationTable, { id });
  },

  findByServicePrincipalId(
    db: Queryable,
    key: Pick<Automation, 'organisationId' | 'servicePrincipalId'>,
  ): Promise<Automation | undefined> {
    return findRow(db, automationTable, key);
  },

  update(db: Queryable, id: Automation['id'], changes: AutomationChanges): Promise<Automation | undefined> {
    return updateRow(db, automationTable, { id }, changes);
  },

  /** The owner's Crons, not deleted, newest first. */
  async listForOwner(db: Queryable, ownerMembershipId: string): Promise<Automation[]> {
    const { rows } = await db.query(
      `select ${automationTable.select} from automation.automations
       where owner_membership_id = $1 and deleted_at is null order by created_at desc limit 500`, [ownerMembershipId]);
    return rows as Automation[];
  },

  /** A removed owner's active Crons, paused for reassignment at once (spec 55.7; D207): the ids paused. */
  async pauseForRemovedOwner(db: Queryable, ownerMembershipId: string, at: string): Promise<string[]> {
    const { rows } = await db.query(
      `update automation.automations set status = 'paused', paused_reason = 'owner_removed', paused_at = $2, lease_expires_at = null, version = version + 1
       where owner_membership_id = $1 and status = 'active' and deleted_at is null returning id`, [ownerMembershipId, at]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  /** Every Cron of the organisation, not deleted, for a manager. */
  async listAll(db: Queryable): Promise<Automation[]> {
    const { rows } = await db.query(
      `select ${automationTable.select} from automation.automations where deleted_at is null order by created_at desc limit 1000`);
    return rows as Automation[];
  },

  /** Locks the row for the run's gate checks, so a pause and a run never cross. */
  async findForUpdate(db: Queryable, id: string): Promise<Automation | undefined> {
    const { rows } = await db.query(`select ${automationTable.select} from automation.automations where id = $1 for update`, [id]);
    return rows[0] as Automation | undefined;
  },

  /**
   * Claims due Crons across organisations (automation.claim_due_automations: identifiers
   * only, a five-minute lease set in the same statement, so two replicas never take one).
   */
  /** Across organisations: the active Crons that watch an object set (identifiers only). */
  async watching(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from automation.watching_automations($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },

  async claimDue(db: Queryable, batch: number, now: string): Promise<{ organisationId: string; id: string; nextRunAt: string }[]> {
    const { rows } = await db.query(
      'select organisation_id as "organisationId", id, next_run_at as "nextRunAt" from automation.claim_due_automations($1, $2)', [batch, now]);
    return rows as { organisationId: string; id: string; nextRunAt: string }[];
  },
};
