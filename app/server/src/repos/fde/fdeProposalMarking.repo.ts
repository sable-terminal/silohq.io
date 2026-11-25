// Data access for fde.fde_proposal_markings, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  fdeProposalMarkingTable,
  type FdeProposalMarking,
  type FdeProposalMarkingPrimaryKey,
  type NewFdeProposalMarking,
} from '../../models/fde/fdeProposalMarking.model.ts';

export const fdeProposalMarkingRepo = {
  insert(db: Queryable, row: NewFdeProposalMarking): Promise<FdeProposalMarking> {
    return insertRow(db, fdeProposalMarkingTable, row);
  },

  findByKey(db: Queryable, key: FdeProposalMarkingPrimaryKey): Promise<FdeProposalMarking | undefined> {
    return findRow(db, fdeProposalMarkingTable, key);
  },

  async listFor(db: Queryable, proposalIds: readonly string[]): Promise<{ proposalId: string; markingId: string }[]> {
    if (proposalIds.length === 0) return [];
    const { rows } = await db.query(
      'select proposal_id as "proposalId", marking_id as "markingId" from fde.fde_proposal_markings where proposal_id = any($1::uuid[])',
      [proposalIds]);
    return rows as { proposalId: string; markingId: string }[];
  },
};
