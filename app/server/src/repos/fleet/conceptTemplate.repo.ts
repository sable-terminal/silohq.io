// Data access for fleet.concept_templates, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  conceptTemplateTable,
  type ConceptTemplate,
  type ConceptTemplateChanges,
  type NewConceptTemplate,
} from '../../models/fleet/conceptTemplate.model.ts';

export const conceptTemplateRepo = {
  insert(db: Queryable, row: NewConceptTemplate): Promise<ConceptTemplate> {
    return insertRow(db, conceptTemplateTable, row);
  },

  findById(db: Queryable, id: ConceptTemplate['id']): Promise<ConceptTemplate | undefined> {
    return findRow(db, conceptTemplateTable, { id });
  },

  update(
    db: Queryable,
    id: ConceptTemplate['id'],
    changes: ConceptTemplateChanges,
  ): Promise<ConceptTemplate | undefined> {
    return updateRow(db, conceptTemplateTable, { id }, changes);
  },

  async listAll(db: Queryable): Promise<ConceptTemplate[]> {
    const { rows } = await db.query(`select ${conceptTemplateTable.select} from fleet.concept_templates order by lower(name), created_at, id`);
    return rows as ConceptTemplate[];
  },

  /** What the cells install: reviewed and withdrawn templates, never drafts, in id order. */
  async listForCells(db: Queryable): Promise<ConceptTemplate[]> {
    const { rows } = await db.query(`select ${conceptTemplateTable.select} from fleet.concept_templates where status in ('reviewed', 'withdrawn') order by id`);
    return rows as ConceptTemplate[];
  },
};
