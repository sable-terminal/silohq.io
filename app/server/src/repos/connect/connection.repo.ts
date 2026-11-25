// Data access for connect.connections, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  connectionTable,
  type Connection,
  type ConnectionChanges,
  type NewConnection,
} from '../../models/connect/connection.model.ts';

export const connectionRepo = {
  /** The cell's live connections, the synthetic organisation's aside (definer function; spec 6.3, D203). */
  async cellConnectionCount(db: Queryable): Promise<number> {
    const { rows } = await db.query('select connect.cell_connection_count() as n');
    return (rows[0] as { n: number }).n;
  },

  insert(db: Queryable, row: NewConnection): Promise<Connection> {
    return insertRow(db, connectionTable, row);
  },

  findById(db: Queryable, id: Connection['id']): Promise<Connection | undefined> {
    return findRow(db, connectionTable, { id });
  },

  update(db: Queryable, id: Connection['id'], changes: ConnectionChanges): Promise<Connection | undefined> {
    return updateRow(db, connectionTable, { id }, changes);
  },

  /**
   * Serialises additions against the plan's connection limit (D76): a transaction lock per
   * organisation, so two additions cannot both take the last place.
   */
  async lockForLimit(db: Queryable, organisationId: string): Promise<void> {
    await db.query(`select pg_advisory_xact_lock(hashtextextended('connect.connections.limit:' || $1::text, 0))`, [organisationId]);
  },

  /** Connections that count against the plan's limit (D76): any not revoked, other than a Silo's own source. */
  async countTowardLimit(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from connect.connections c join connect.connectors k on k.id = c.connector_id
       where c.status <> 'revoked' and k.source_route <> 'silo'`);
    return rows[0]!.n;
  },

  /** Newest first, as the connections screen lists them. */
  /** The oldest connection to a connector (a Silo's connector has one). */
  async firstForConnector(db: Queryable, connectorId: string): Promise<Connection | undefined> {
    const { rows } = await db.query(`select ${connectionTable.select} from connect.connections where connector_id = $1 order by created_at, id limit 1`, [connectorId]);
    return rows[0] as Connection | undefined;
  },

  async list(db: Queryable, limit: number): Promise<Connection[]> {
    const { rows } = await db.query(
      `select ${connectionTable.select} from connect.connections order by created_at desc, id desc limit $1`, [limit]);
    return rows as Connection[];
  },

  /**
   * Changes the row only if it is still at the version the caller read (optimistic lock),
   * and moves the version on. Undefined when another change got there first.
   */
  async updateAtVersion(db: Queryable, id: Connection['id'], version: number, changes: ConnectionChanges): Promise<Connection | undefined> {
    const updated = await updateRow(db, connectionTable, { id, version }, { ...changes, version: version + 1 });
    return updated;
  },

  /** A re-check found the connection healthy (spec 17.3). Moves no version: health is not a change of the row's meaning. */
  async markHealthy(db: Queryable, id: string): Promise<void> {
    await db.query(`update connect.connections set last_healthy_at = now() where id = $1 and status = 'active'`, [id]);
  },

  /**
   * Halts an active connection on drift (spec 17.3: a change of meaning, a removed object, a
   * type that cannot hold its values). Undefined when it was not active.
   */
  async haltForDrift(db: Queryable, id: string, reason: string): Promise<Connection | undefined> {
    const { rows } = await db.query(
      `update connect.connections set status = 'halted', halted_reason = $2, halted_at = now(), version = version + 1
       where id = $1 and status = 'active' returning ${connectionTable.select}`, [id, reason]);
    return rows[0] as Connection | undefined;
  },

  /** Moves the connection to a repaired version, if it still runs the version repaired. */
  async moveToManifest(db: Queryable, id: string, fromManifestId: string, toManifestId: string): Promise<Connection | undefined> {
    const { rows } = await db.query(
      `update connect.connections set manifest_id = $3, version = version + 1
       where id = $1 and manifest_id = $2 and status <> 'revoked' returning ${connectionTable.select}`, [id, fromManifestId, toManifestId]);
    return rows[0] as Connection | undefined;
  },

  /** The live connections a member owns (spec 55.7), locked for their transfer. */
  async ownedBy(db: Queryable, membershipId: string): Promise<Connection[]> {
    const { rows } = await db.query(
      `select ${connectionTable.select} from connect.connections where owning_membership_id = $1 and status <> 'revoked' order by created_at, id for update`,
      [membershipId]);
    return rows as Connection[];
  },
};
