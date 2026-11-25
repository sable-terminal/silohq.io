// Data access for action.approval_chain_connections, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  approvalChainConnectionTable,
  type ApprovalChainConnection,
  type NewApprovalChainConnection,
} from '../../models/action/approvalChainConnection.model.ts';

export const approvalChainConnectionRepo = {
  insert(db: Queryable, row: NewApprovalChainConnection): Promise<ApprovalChainConnection> {
    return insertRow(db, approvalChainConnectionTable, row);
  },

  findById(db: Queryable, id: ApprovalChainConnection['id']): Promise<ApprovalChainConnection | undefined> {
    return findRow(db, approvalChainConnectionTable, { id });
  },

  findByChainIdAndConnectionId(
    db: Queryable,
    key: Pick<ApprovalChainConnection, 'organisationId' | 'chainId' | 'connectionId'>,
  ): Promise<ApprovalChainConnection | undefined> {
    return findRow(db, approvalChainConnectionTable, key);
  },

  async listByChain(db: Queryable, chainId: string): Promise<string[]> {
    const { rows } = await db.query('select connection_id from action.approval_chain_connections where chain_id = $1 order by created_at, id', [chainId]);
    return rows.map((r: { connection_id: string }) => r.connection_id);
  },
};
