// Data access for action.approval_policies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  approvalPolicyTable,
  type ApprovalPolicy,
  type ApprovalPolicyChanges,
  type NewApprovalPolicy,
} from '../../models/action/approvalPolicy.model.ts';

export const approvalPolicyRepo = {
  insert(db: Queryable, row: NewApprovalPolicy): Promise<ApprovalPolicy> {
    return insertRow(db, approvalPolicyTable, row);
  },

  findById(db: Queryable, id: ApprovalPolicy['id']): Promise<ApprovalPolicy | undefined> {
    return findRow(db, approvalPolicyTable, { id });
  },

  update(
    db: Queryable,
    id: ApprovalPolicy['id'],
    changes: ApprovalPolicyChanges,
  ): Promise<ApprovalPolicy | undefined> {
    return updateRow(db, approvalPolicyTable, { id }, changes);
  },

  /** Policies in force (not superseded), optionally for one connection and the organisation default. */
  async listLive(db: Queryable, connectionId?: string): Promise<ApprovalPolicy[]> {
    const { rows } = await db.query(
      `select ${approvalPolicyTable.select} from action.approval_policies
        where superseded_at is null and ($1::uuid is null or connection_id = $1 or connection_id is null) order by created_at`, [connectionId ?? null]);
    return rows as ApprovalPolicy[];
  },

  async listAll(db: Queryable, connectionId?: string): Promise<ApprovalPolicy[]> {
    const { rows } = await db.query(
      `select ${approvalPolicyTable.select} from action.approval_policies where ($1::uuid is null or connection_id = $1) order by created_at`, [connectionId ?? null]);
    return rows as ApprovalPolicy[];
  },
};
