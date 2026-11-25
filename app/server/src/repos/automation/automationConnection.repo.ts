// Data access for automation.automation_connections, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  automationConnectionTable,
  type AutomationConnection,
  type AutomationConnectionPrimaryKey,
  type NewAutomationConnection,
} from '../../models/automation/automationConnection.model.ts';

export const automationConnectionRepo = {
  insert(db: Queryable, row: NewAutomationConnection): Promise<AutomationConnection> {
    return insertRow(db, automationConnectionTable, row);
  },

  findByKey(db: Queryable, key: AutomationConnectionPrimaryKey): Promise<AutomationConnection | undefined> {
    return findRow(db, automationConnectionTable, key);
  },

  remove(db: Queryable, key: AutomationConnectionPrimaryKey): Promise<boolean> {
    return deleteRow(db, automationConnectionTable, key);
  },

  async listFor(db: Queryable, automationId: string): Promise<string[]> {
    const { rows } = await db.query(
      'select connection_id as "connectionId" from automation.automation_connections where automation_id = $1 order by connection_id', [automationId]);
    return (rows as { connectionId: string }[]).map((r) => r.connectionId);
  },

  /** Replaces the set: when the Cron is saved and after each run (spec 40.8). */
  async replaceFor(db: Queryable, organisationId: string, automationId: string, connectionIds: readonly string[]): Promise<void> {
    await db.query('delete from automation.automation_connections where automation_id = $1 and not (connection_id = any($2::uuid[]))',
      [automationId, [...connectionIds]]);
    if (connectionIds.length === 0) return;
    await db.query(
      `insert into automation.automation_connections (organisation_id, automation_id, connection_id)
       select $1, $2, c from unnest($3::uuid[]) as c on conflict do nothing`, [organisationId, automationId, [...new Set(connectionIds)]]);
  },

  /**
   * What a Cron's principal is granted to read (spec 40.6): the connections its live Cron's
   * question reads. Empty for a principal whose Cron is deleted or stopped.
   */
  async grantedToPrincipal(db: Queryable, servicePrincipalId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select c.connection_id as "connectionId" from automation.automations a
       join automation.automation_connections c on c.organisation_id = a.organisation_id and c.automation_id = a.id
       where a.service_principal_id = $1 and a.deleted_at is null and a.status <> 'stopped'`, [servicePrincipalId]);
    return (rows as { connectionId: string }[]).map((r) => r.connectionId);
  },
};
