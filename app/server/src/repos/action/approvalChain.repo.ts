// Data access for action.approval_chains, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  approvalChainTable,
  type ApprovalChain,
  type ApprovalChainChanges,
  type NewApprovalChain,
} from '../../models/action/approvalChain.model.ts';

export const approvalChainRepo = {
  insert(db: Queryable, row: NewApprovalChain): Promise<ApprovalChain> {
    return insertRow(db, approvalChainTable, row);
  },

  findById(db: Queryable, id: ApprovalChain['id']): Promise<ApprovalChain | undefined> {
    return findRow(db, approvalChainTable, { id });
  },

  update(
    db: Queryable,
    id: ApprovalChain['id'],
    changes: ApprovalChainChanges,
  ): Promise<ApprovalChain | undefined> {
    return updateRow(db, approvalChainTable, { id }, changes);
  },

  /** The mutation's latest chain. */
  async latestForMutation(db: Queryable, mutationId: string): Promise<ApprovalChain | undefined> {
    const { rows } = await db.query(
      `select ${approvalChainTable.select} from action.approval_chains where mutation_id = $1 order by created_at desc, id desc limit 1`, [mutationId]);
    return rows[0] as ApprovalChain | undefined;
  },

  /** Locks the chain while a decision is recorded, so decisions are counted in turn. */
  async findForUpdate(db: Queryable, id: string): Promise<ApprovalChain | undefined> {
    const { rows } = await db.query(`select ${approvalChainTable.select} from action.approval_chains where id = $1 for update`, [id]);
    return rows[0] as ApprovalChain | undefined;
  },

  /** Pending chains, oldest first: the approvals inbox before qualification is checked. */
  async listPending(db: Queryable, limit: number): Promise<ApprovalChain[]> {
    const { rows } = await db.query(
      `select ${approvalChainTable.select} from action.approval_chains where status = 'pending' order by created_at limit $1`, [limit]);
    return rows as ApprovalChain[];
  },
};
