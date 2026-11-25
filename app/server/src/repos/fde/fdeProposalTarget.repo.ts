// Data access for fde.fde_proposal_targets, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fdeProposalTargetTable,
  type FdeProposalTarget,
  type NewFdeProposalTarget,
} from '../../models/fde/fdeProposalTarget.model.ts';

export const fdeProposalTargetRepo = {
  insert(db: Queryable, row: NewFdeProposalTarget): Promise<FdeProposalTarget> {
    return insertRow(db, fdeProposalTargetTable, row);
  },

  findById(db: Queryable, id: FdeProposalTarget['id']): Promise<FdeProposalTarget | undefined> {
    return findRow(db, fdeProposalTargetTable, { id });
  },

  findByProposalIdAndRelation(
    db: Queryable,
    key: Pick<FdeProposalTarget, 'organisationId' | 'proposalId' | 'relation'>,
  ): Promise<FdeProposalTarget | undefined> {
    return findRow(db, fdeProposalTargetTable, key);
  },

  async appliedFor(db: Queryable, proposalIds: readonly string[]): Promise<FdeProposalTarget[]> {
    if (proposalIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${fdeProposalTargetTable.select} from fde.fde_proposal_targets where proposal_id = any($1::uuid[]) and relation = 'applied'`,
      [proposalIds]);
    return rows as FdeProposalTarget[];
  },
};
