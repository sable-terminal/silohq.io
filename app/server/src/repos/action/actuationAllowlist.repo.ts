// Data access for action.actuation_allowlists, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  actuationAllowlistTable,
  type ActuationAllowlist,
  type ActuationAllowlistChanges,
  type NewActuationAllowlist,
} from '../../models/action/actuationAllowlist.model.ts';

export const actuationAllowlistRepo = {
  insert(db: Queryable, row: NewActuationAllowlist): Promise<ActuationAllowlist> {
    return insertRow(db, actuationAllowlistTable, row);
  },

  findById(db: Queryable, id: ActuationAllowlist['id']): Promise<ActuationAllowlist | undefined> {
    return findRow(db, actuationAllowlistTable, { id });
  },

  update(
    db: Queryable,
    id: ActuationAllowlist['id'],
    changes: ActuationAllowlistChanges,
  ): Promise<ActuationAllowlist | undefined> {
    return updateRow(db, actuationAllowlistTable, { id }, changes);
  },

  /** The live entry for a node of a connection, if any. */
  async liveFor(db: Queryable, connectionId: string, transport: string, nodeAddress: string): Promise<ActuationAllowlist | undefined> {
    const { rows } = await db.query(
      `select ${actuationAllowlistTable.select} from action.actuation_allowlists
        where connection_id = $1 and transport = $2 and node_address = $3 and removed_at is null`, [connectionId, transport, nodeAddress]);
    return rows[0] as ActuationAllowlist | undefined;
  },

  /** The live entries of an agent pool's connections that are not revoked: what its agents hold (47.4). */
  async liveForPool(db: Queryable, poolId: string): Promise<ActuationAllowlist[]> {
    const { rows } = await db.query(
      `select ${actuationAllowlistTable.select.split(', ').map((c) => `a.${c}`).join(', ')}
         from action.actuation_allowlists a join connect.connections c on c.id = a.connection_id
        where c.agent_pool_id = $1 and c.status <> 'revoked' and a.removed_at is null
        order by a.connection_id, a.created_at, a.id limit 50000`, [poolId]);
    return rows as ActuationAllowlist[];
  },

  /** A connection's live entries, oldest first. */
  async liveForConnection(db: Queryable, connectionId: string): Promise<ActuationAllowlist[]> {
    const { rows } = await db.query(
      `select ${actuationAllowlistTable.select} from action.actuation_allowlists where connection_id = $1 and removed_at is null order by created_at, id`,
      [connectionId]);
    return rows as ActuationAllowlist[];
  },

  /** Ends a live entry; undefined if it was removed already. */
  async remove(db: Queryable, id: string): Promise<ActuationAllowlist | undefined> {
    const { rows } = await db.query(
      `update action.actuation_allowlists set removed_at = now() where id = $1 and removed_at is null returning ${actuationAllowlistTable.select}`, [id]);
    return rows[0] as ActuationAllowlist | undefined;
  },
};
