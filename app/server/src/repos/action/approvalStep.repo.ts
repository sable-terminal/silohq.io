// Data access for action.approval_steps, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  approvalStepTable,
  type ApprovalStep,
  type ApprovalStepChanges,
  type NewApprovalStep,
} from '../../models/action/approvalStep.model.ts';

export const approvalStepRepo = {
  insert(db: Queryable, row: NewApprovalStep): Promise<ApprovalStep> {
    return insertRow(db, approvalStepTable, row);
  },

  findById(db: Queryable, id: ApprovalStep['id']): Promise<ApprovalStep | undefined> {
    return findRow(db, approvalStepTable, { id });
  },

  findByChainIdAndApproverMembershipId(
    db: Queryable,
    key: Pick<ApprovalStep, 'organisationId' | 'chainId' | 'approverMembershipId'>,
  ): Promise<ApprovalStep | undefined> {
    return findRow(db, approvalStepTable, key);
  },

  findByChainIdAndSequence(
    db: Queryable,
    key: Pick<ApprovalStep, 'organisationId' | 'chainId' | 'sequence'>,
  ): Promise<ApprovalStep | undefined> {
    return findRow(db, approvalStepTable, key);
  },

  update(
    db: Queryable,
    id: ApprovalStep['id'],
    changes: ApprovalStepChanges,
  ): Promise<ApprovalStep | undefined> {
    return updateRow(db, approvalStepTable, { id }, changes);
  },

  async listByChain(db: Queryable, chainId: string): Promise<ApprovalStep[]> {
    const { rows } = await db.query(
      `select ${approvalStepTable.select} from action.approval_steps where chain_id = $1 order by sequence nulls last, created_at, id`, [chainId]);
    return rows as ApprovalStep[];
  },
};
