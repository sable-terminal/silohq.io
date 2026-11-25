// Data access for ontology.concept_templates, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by the catalogue as the migration role, installing Fleet's signed set (D210).
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { conceptTemplateTable, type ConceptTemplate } from '../../models/ontology/conceptTemplate.model.ts';

export const conceptTemplateRepo = {
  findById(db: Queryable, id: ConceptTemplate['id']): Promise<ConceptTemplate | undefined> {
    return findRow(db, conceptTemplateTable, { id });
  },

  /** The reviewed set, by name: all a tenant may read (row-level security shows nothing else). Small: tens to low hundreds. */
  async listReviewed(db: Queryable): Promise<ConceptTemplate[]> {
    const { rows } = await db.query(`select ${conceptTemplateTable.select} from ontology.concept_templates where status = 'reviewed' order by lower(name), id`);
    return rows as ConceptTemplate[];
  },

  /** A template Fleet distributed, as it was reviewed or withdrawn there (migration role; D210). */
  async install(db: Queryable, t: {
    id: string; name: string; fieldNames: string[]; revision: number; authoredBy: string; reviewedBy: string | null; reviewedAt: string | null; status: 'reviewed' | 'withdrawn';
  }): Promise<void> {
    await db.query(
      `insert into ontology.concept_templates (id, name, field_names, authored_by, reviewed_by, reviewed_at, status, revision)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [t.id, t.name, t.fieldNames, t.authoredBy, t.reviewedBy, t.reviewedAt, t.status, t.revision]);
  },

  /** A reviewed template Fleet withdrew: it names no proposal from now on (migration role; D210). */
  async withdraw(db: Queryable, id: string): Promise<boolean> {
    const result = await db.query(`update ontology.concept_templates set status = 'withdrawn' where id = $1 and status <> 'withdrawn'`, [id]);
    return (result.rowCount ?? 0) > 0;
  },
};
