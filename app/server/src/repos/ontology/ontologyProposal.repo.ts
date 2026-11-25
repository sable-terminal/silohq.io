// Data access for ontology.ontology_proposals, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  ontologyProposalTable,
  type NewOntologyProposal,
  type OntologyProposal,
  type OntologyProposalChanges,
} from '../../models/ontology/ontologyProposal.model.ts';

export const ontologyProposalRepo = {
  insert(db: Queryable, row: NewOntologyProposal): Promise<OntologyProposal> {
    return insertRow(db, ontologyProposalTable, row);
  },

  findById(db: Queryable, id: OntologyProposal['id']): Promise<OntologyProposal | undefined> {
    return findRow(db, ontologyProposalTable, { id });
  },

  update(
    db: Queryable,
    id: OntologyProposal['id'],
    changes: OntologyProposalChanges,
  ): Promise<OntologyProposal | undefined> {
    return updateRow(db, ontologyProposalTable, { id }, changes);
  },

  async list(db: Queryable, openOnly: boolean, limit: number): Promise<OntologyProposal[]> {
    const { rows } = await db.query(
      `select ${ontologyProposalTable.select} from ontology.ontology_proposals
        where ($1::boolean is false or status in ('draft', 'in_review', 'approved')) order by created_at desc limit $2`, [openOnly, limit]);
    return rows as OntologyProposal[];
  },

  /** The branch's proposal still under way (draft, in review or approved), if any. */
  async openForBranch(db: Queryable, branchId: string): Promise<OntologyProposal | undefined> {
    const { rows } = await db.query(
      `select ${ontologyProposalTable.select} from ontology.ontology_proposals
        where branch_id = $1 and status in ('draft', 'in_review', 'approved') order by created_at desc limit 1`, [branchId]);
    return rows[0] as OntologyProposal | undefined;
  },

  async lock(db: Queryable, id: string): Promise<OntologyProposal | undefined> {
    const { rows } = await db.query(`select ${ontologyProposalTable.select} from ontology.ontology_proposals where id = $1 for update`, [id]);
    return rows[0] as OntologyProposal | undefined;
  },
};
