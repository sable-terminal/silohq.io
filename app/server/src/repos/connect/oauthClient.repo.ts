// Data access for connect.oauth_clients, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  oauthClientTable,
  type NewOauthClient,
  type OauthClient,
  type OauthClientChanges,
} from '../../models/connect/oauthClient.model.ts';

export const oauthClientRepo = {
  insert(db: Queryable, row: NewOauthClient): Promise<OauthClient> {
    return insertRow(db, oauthClientTable, row);
  },

  findById(db: Queryable, id: OauthClient['id']): Promise<OauthClient | undefined> {
    return findRow(db, oauthClientTable, { id });
  },

  update(
    db: Queryable,
    id: OauthClient['id'],
    changes: OauthClientChanges,
  ): Promise<OauthClient | undefined> {
    return updateRow(db, oauthClientTable, { id }, changes);
  },

  /** The system organisation's live Silo-registered client for a connector (run with the system organisation's context). */
  async siloRegisteredForConnector(db: Queryable, connectorId: string): Promise<OauthClient | undefined> {
    const { rows } = await db.query(
      `select ${oauthClientTable.select} from connect.oauth_clients
       where connector_id = $1 and origin = 'silo_registered' and revoked_at is null order by created_at desc, id desc limit 1`, [connectorId]);
    return rows[0] as OauthClient | undefined;
  },

  /** The organisation's clients, newest first: the live ones, or with the revoked as well (RLS keeps it to the organisation). */
  async listForOrganisation(db: Queryable, includeRevoked: boolean, limit = 500): Promise<OauthClient[]> {
    const { rows } = await db.query(
      `select ${oauthClientTable.select} from connect.oauth_clients
       where ($1 or revoked_at is null) order by created_at desc, id desc limit $2`, [includeRevoked, limit]);
    return rows as OauthClient[];
  },

  /** The organisation's live client for a connector, newest first (spec 15.4: its own client before any other). */
  async activeForConnector(db: Queryable, connectorId: string): Promise<OauthClient | undefined> {
    const { rows } = await db.query(
      `select ${oauthClientTable.select} from connect.oauth_clients
       where connector_id = $1 and revoked_at is null order by created_at desc, id desc limit 1`, [connectorId]);
    return rows[0] as OauthClient | undefined;
  },
};
