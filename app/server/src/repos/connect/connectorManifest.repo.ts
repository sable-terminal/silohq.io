// Data access for connect.connector_manifests, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  connectorManifestTable,
  type ConnectorManifest,
  type ConnectorManifestChanges,
  type NewConnectorManifest,
} from '../../models/connect/connectorManifest.model.ts';

export const connectorManifestRepo = {
  insert(db: Queryable, row: NewConnectorManifest): Promise<ConnectorManifest> {
    return insertRow(db, connectorManifestTable, row);
  },

  findById(db: Queryable, id: ConnectorManifest['id']): Promise<ConnectorManifest | undefined> {
    return findRow(db, connectorManifestTable, { id });
  },

  findByConnectorIdAndVersion(
    db: Queryable,
    key: Pick<ConnectorManifest, 'connectorId' | 'version'>,
  ): Promise<ConnectorManifest | undefined> {
    return findRow(db, connectorManifestTable, key);
  },

  update(
    db: Queryable,
    id: ConnectorManifest['id'],
    changes: ConnectorManifestChanges,
  ): Promise<ConnectorManifest | undefined> {
    return updateRow(db, connectorManifestTable, { id }, changes);
  },

  /** The connector's current version: the one not superseded. */
  async current(db: Queryable, connectorId: string): Promise<ConnectorManifest | undefined> {
    const { rows } = await db.query(
      `select ${connectorManifestTable.select} from connect.connector_manifests
       where connector_id = $1 and superseded_at is null`, [connectorId]);
    return rows[0] as ConnectorManifest | undefined;
  },

  async listForConnector(db: Queryable, connectorId: string, limit: number): Promise<ConnectorManifest[]> {
    const { rows } = await db.query(
      `select ${connectorManifestTable.select} from connect.connector_manifests
       where connector_id = $1 order by created_at desc, id desc limit $2`, [connectorId, limit]);
    return rows as ConnectorManifest[];
  },

  /** Marks the current version superseded, so a new one can become current. */
  async supersedeCurrent(db: Queryable, connectorId: string): Promise<void> {
    await db.query(
      `update connect.connector_manifests set superseded_at = now()
       where connector_id = $1 and superseded_at is null`, [connectorId]);
  },

  /** First query or write against a version: from then on it never changes (spec 14.3). */
  /**
   * A repair applied (spec 17.3): when the version repaired was the connector's current one,
   * the repaired version becomes current. A repair is created not current, so a version that
   * failed its sandbox never becomes what new connections start on.
   */
  async makeCurrentAfter(db: Queryable, connectorId: string, repairedId: string, repairId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update connect.connector_manifests set superseded_at = now() where connector_id = $1 and id = $2 and superseded_at is null`,
      [connectorId, repairedId]);
    if ((rowCount ?? 0) === 0) return false;
    await db.query('update connect.connector_manifests set superseded_at = null where connector_id = $1 and id = $2', [connectorId, repairId]);
    return true;
  },

  async markFirstUsed(db: Queryable, id: string): Promise<void> {
    await db.query('update connect.connector_manifests set first_used_at = now() where id = $1 and first_used_at is null', [id]);
  },
};
