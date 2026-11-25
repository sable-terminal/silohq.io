// Data access for ontology.ontology_branches, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  ontologyBranchTable,
  type NewOntologyBranch,
  type OntologyBranch,
  type OntologyBranchChanges,
} from '../../models/ontology/ontologyBranch.model.ts';

export const ontologyBranchRepo = {
  insert(db: Queryable, row: NewOntologyBranch): Promise<OntologyBranch> {
    return insertRow(db, ontologyBranchTable, row);
  },

  findById(db: Queryable, id: OntologyBranch['id']): Promise<OntologyBranch | undefined> {
    return findRow(db, ontologyBranchTable, { id });
  },

  update(
    db: Queryable,
    id: OntologyBranch['id'],
    changes: OntologyBranchChanges,
  ): Promise<OntologyBranch | undefined> {
    return updateRow(db, ontologyBranchTable, { id }, changes);
  },

  async findMain(db: Queryable): Promise<OntologyBranch | undefined> {
    const { rows } = await db.query(`select ${ontologyBranchTable.select} from ontology.ontology_branches where kind = 'main'`);
    return rows[0] as OntologyBranch | undefined;
  },

  /** The branch, locked for this transaction: commits on one branch are serialised. */
  async lock(db: Queryable, id: string): Promise<OntologyBranch | undefined> {
    const { rows } = await db.query(`select ${ontologyBranchTable.select} from ontology.ontology_branches where id = $1 for update`, [id]);
    return rows[0] as OntologyBranch | undefined;
  },

  async list(db: Queryable, openOnly: boolean, limit: number): Promise<OntologyBranch[]> {
    const { rows } = await db.query(
      `select ${ontologyBranchTable.select} from ontology.ontology_branches
        where ($1::boolean is false or status = 'open') order by created_at desc limit $2`, [openOnly, limit]);
    return rows as OntologyBranch[];
  },
};
