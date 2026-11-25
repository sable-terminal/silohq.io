// Data access for connect.industrial_endpoints, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  industrialEndpointTable,
  type IndustrialEndpoint,
  type IndustrialEndpointChanges,
  type NewIndustrialEndpoint,
} from '../../models/connect/industrialEndpoint.model.ts';

export const industrialEndpointRepo = {
  insert(db: Queryable, row: NewIndustrialEndpoint): Promise<IndustrialEndpoint> {
    return insertRow(db, industrialEndpointTable, row);
  },

  findById(db: Queryable, id: IndustrialEndpoint['id']): Promise<IndustrialEndpoint | undefined> {
    return findRow(db, industrialEndpointTable, { id });
  },

  findByConnectionIdAndEndpointUrl(
    db: Queryable,
    key: Pick<IndustrialEndpoint, 'organisationId' | 'connectionId' | 'endpointUrl'>,
  ): Promise<IndustrialEndpoint | undefined> {
    return findRow(db, industrialEndpointTable, key);
  },

  update(
    db: Queryable,
    id: IndustrialEndpoint['id'],
    changes: IndustrialEndpointChanges,
  ): Promise<IndustrialEndpoint | undefined> {
    return updateRow(db, industrialEndpointTable, { id }, changes);
  },

  /** A pool's active endpoints, oldest first: what a discovery scan on its agent may reach (spec 19.2). */
  async activeForPool(db: Queryable, poolId: string): Promise<IndustrialEndpoint[]> {
    const { rows } = await db.query(
      `select ${industrialEndpointTable.select} from connect.industrial_endpoints where agent_pool_id = $1 and status = 'active'
       order by created_at limit 500`, [poolId]);
    return rows as IndustrialEndpoint[];
  },

  /** An active endpoint becomes untrusted: whether it was active. */
  async markUntrustedIfActive(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update connect.industrial_endpoints set status = 'untrusted' where id = $1 and status = 'active'`, [id]);
    return (rowCount ?? 0) > 0;
  },

  /** A connection's endpoints, newest first. */
  async listForConnection(db: Queryable, connectionId: string): Promise<IndustrialEndpoint[]> {
    const { rows } = await db.query(
      `select ${industrialEndpointTable.select} from connect.industrial_endpoints where connection_id = $1 order by created_at desc`, [connectionId]);
    return rows as IndustrialEndpoint[];
  },

  /** The endpoint a connection reads through: its newest active one. */
  async activeForConnection(db: Queryable, connectionId: string): Promise<IndustrialEndpoint | undefined> {
    const { rows } = await db.query(
      `select ${industrialEndpointTable.select} from connect.industrial_endpoints where connection_id = $1 and status = 'active'
       order by created_at desc limit 1`, [connectionId]);
    return rows[0] as IndustrialEndpoint | undefined;
  },
};
