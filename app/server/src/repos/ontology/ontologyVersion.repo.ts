// Data access for ontology.ontology_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  ontologyVersionTable,
  type NewOntologyVersion,
  type OntologyVersion,
} from '../../models/ontology/ontologyVersion.model.ts';

export const ontologyVersionRepo = {
  insert(db: Queryable, row: NewOntologyVersion): Promise<OntologyVersion> {
    return insertRow(db, ontologyVersionTable, row);
  },

  findById(db: Queryable, id: OntologyVersion['id']): Promise<OntologyVersion | undefined> {
    return findRow(db, ontologyVersionTable, { id });
  },

  findByBranchIdAndSequence(
    db: Queryable,
    key: Pick<OntologyVersion, 'organisationId' | 'branchId' | 'sequence'>,
  ): Promise<OntologyVersion | undefined> {
    return findRow(db, ontologyVersionTable, key);
  },

  /**
   * The chain of a version: itself, its parent, and so back to main's first version, each
   * with its depth from the given version and whether it sits on main. A branch's first
   * version has main's head as its parent, so the chain reads through to main's history.
   */
  async chain(db: Queryable, versionId: string): Promise<{ id: string; depth: number; onMain: boolean }[]> {
    const { rows } = await db.query(
      `with recursive c as (
         select v.id, v.branch_id, v.parent_version_id, 0 as depth from ontology.ontology_versions v where v.id = $1
         union all
         select p.id, p.branch_id, p.parent_version_id, c.depth + 1
           from ontology.ontology_versions p join c on p.id = c.parent_version_id
       )
       select c.id, c.depth, (b.kind = 'main') as "onMain"
         from c join ontology.ontology_branches b on b.organisation_id = (select current_setting('app.org_id')::uuid) and b.id = c.branch_id
        order by c.depth`, [versionId]);
    return rows as { id: string; depth: number; onMain: boolean }[];
  },

  /** A branch's versions, newest first. */
  async listForBranch(db: Queryable, branchId: string, limit: number): Promise<OntologyVersion[]> {
    const { rows } = await db.query(
      `select ${ontologyVersionTable.select} from ontology.ontology_versions where branch_id = $1 order by sequence desc limit $2`,
      [branchId, limit]);
    return rows as OntologyVersion[];
  },

  /** The next sequence on a branch; call under the branch's lock. */
  async nextSequence(db: Queryable, branchId: string): Promise<number> {
    const { rows } = await db.query('select coalesce(max(sequence), 0)::int + 1 as n from ontology.ontology_versions where branch_id = $1', [branchId]);
    return (rows[0] as { n: number }).n;
  },

  /** For this transaction only: a rollback may bring an element's status back to active (spec 25.8). */
  async allowStatusRollback(db: Queryable): Promise<void> {
    await db.query(`select set_config('app.ontology_rollback', 'on', true)`);
  },
};
