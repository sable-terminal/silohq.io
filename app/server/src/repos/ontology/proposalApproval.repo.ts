// Data access for ontology.proposal_approvals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  proposalApprovalTable,
  type NewProposalApproval,
  type ProposalApproval,
} from '../../models/ontology/proposalApproval.model.ts';

export const proposalApprovalRepo = {
  insert(db: Queryable, row: NewProposalApproval): Promise<ProposalApproval> {
    return insertRow(db, proposalApprovalTable, row);
  },

  findById(db: Queryable, id: ProposalApproval['id']): Promise<ProposalApproval | undefined> {
    return findRow(db, proposalApprovalTable, { id });
  },

  findByProposalIdAndMembershipIdAndPermission(
    db: Queryable,
    key: Pick<ProposalApproval, 'organisationId' | 'proposalId' | 'membershipId' | 'permission'>,
  ): Promise<ProposalApproval | undefined> {
    return findRow(db, proposalApprovalTable, key);
  },

  async listForProposal(db: Queryable, proposalId: string): Promise<ProposalApproval[]> {
    const { rows } = await db.query(
      `select ${proposalApprovalTable.select} from ontology.proposal_approvals where proposal_id = $1 order by approved_at`, [proposalId]);
    return rows as ProposalApproval[];
  },
};
