// Data access for automation.authorisation_connections, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  authorisationConnectionTable,
  type AuthorisationConnection,
  type AuthorisationConnectionPrimaryKey,
  type NewAuthorisationConnection,
} from '../../models/automation/authorisationConnection.model.ts';

export const authorisationConnectionRepo = {
  /**
   * What a Cron's principal may write through (spec 40.5): the connections named by the live
   * mutate authorisations of its live Cron, an execute authorisation only until it expires.
   */
  async writableToPrincipal(db: Queryable, servicePrincipalId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct ac.connection_id as "connectionId" from automation.automations a
       join automation.automation_authorisations z on z.organisation_id = a.organisation_id and z.automation_id = a.id
       join automation.authorisation_connections ac on ac.organisation_id = z.organisation_id and ac.authorisation_id = z.id
       where a.service_principal_id = $1 and a.deleted_at is null and a.status <> 'stopped' and z.revoked_at is null`, [servicePrincipalId]);
    return (rows as { connectionId: string }[]).map((r) => r.connectionId);
  },

  /** The connections an authorisation names. */
  async listFor(db: Queryable, authorisationId: string): Promise<string[]> {
    const { rows } = await db.query(
      'select connection_id as "connectionId" from automation.authorisation_connections where authorisation_id = $1 order by connection_id', [authorisationId]);
    return (rows as { connectionId: string }[]).map((r) => r.connectionId);
  },

  insert(db: Queryable, row: NewAuthorisationConnection): Promise<AuthorisationConnection> {
    return insertRow(db, authorisationConnectionTable, row);
  },

  findByKey(
    db: Queryable,
    key: AuthorisationConnectionPrimaryKey,
  ): Promise<AuthorisationConnection | undefined> {
    return findRow(db, authorisationConnectionTable, key);
  },
};
