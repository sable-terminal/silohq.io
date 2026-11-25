// Data access for siloes.silo_extractions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloExtractionTable,
  type NewSiloExtraction,
  type SiloExtraction,
  type SiloExtractionChanges,
} from '../../models/siloes/siloExtraction.model.ts';

export const siloExtractionRepo = {
  insert(db: Queryable, row: NewSiloExtraction): Promise<SiloExtraction> {
    return insertRow(db, siloExtractionTable, row);
  },

  findById(db: Queryable, id: SiloExtraction['id']): Promise<SiloExtraction | undefined> {
    return findRow(db, siloExtractionTable, { id });
  },

  findByFileIdAndObjectAndRowRefAndField(
    db: Queryable,
    key: Pick<SiloExtraction, 'organisationId' | 'fileId' | 'object' | 'rowRef' | 'field'>,
  ): Promise<SiloExtraction | undefined> {
    return findRow(db, siloExtractionTable, key);
  },

  update(
    db: Queryable,
    id: SiloExtraction['id'],
    changes: SiloExtractionChanges,
  ): Promise<SiloExtraction | undefined> {
    return updateRow(db, siloExtractionTable, { id }, changes);
  },

  /** Every extraction of one file, in row and field order: a Silo rebuilt after a move reloads its rows from them (D212). */
  async listForFile(db: Queryable, fileId: string): Promise<SiloExtraction[]> {
    const { rows } = await db.query(`select ${siloExtractionTable.select} from siloes.silo_extractions where file_id = $1 order by object, row_ref, field, created_at desc`, [fileId]);
    return rows as SiloExtraction[];
  },

  async listForSilo(db: Queryable, siloId: string, f: { fileId?: string | undefined; unconfirmed: boolean }): Promise<SiloExtraction[]> {
    const { rows } = await db.query(
      `select ${siloExtractionTable.select.split(', ').map((c) => (c.startsWith('"') ? `e.${c}` : c)).join(', ')} from siloes.silo_extractions e
       join siloes.silo_files f on f.organisation_id = e.organisation_id and f.id = e.file_id
       where f.silo_id = $1 and ($2::uuid is null or e.file_id = $2) and ($3::boolean is false or e.confirmed_at is null)
       order by e.created_at, e.id limit 1000`, [siloId, f.fileId ?? null, f.unconfirmed]);
    return rows as SiloExtraction[];
  },

  /**
   * The latest extraction of each field of these rows of an object in a Silo, with its
   * document's name: the object view's flag (34.3). The sealed value is not read.
   */
  async latestForRows(db: Queryable, siloId: string, object: string, rowRefs: readonly string[]): Promise<(SiloExtraction & { filename: string })[]> {
    if (rowRefs.length === 0) return [];
    const { rows } = await db.query(
      `select distinct on (e.row_ref, e.field) ${siloExtractionTable.select.split(', ').map((c) => (c.startsWith('"') ? `e.${c}` : c)).join(', ')},
              f.filename
         from siloes.silo_extractions e
         join siloes.silo_files f on f.organisation_id = e.organisation_id and f.id = e.file_id
        where f.silo_id = $1 and e.object = $2 and e.row_ref = any($3::text[])
        order by e.row_ref, e.field, e.created_at desc, e.id desc`, [siloId, object, rowRefs]);
    return rows as (SiloExtraction & { filename: string })[];
  },

  /** Extracted values of a file, an object or the whole Silo, with their confirmations (spec 70.2). */
  async purge(db: Queryable, organisationId: string, siloId: string, fileId: string | null, object: string | null): Promise<number> {
    const { rows } = await db.query('select siloes.purge_extractions($1, $2, $3, $4)::int as removed', [organisationId, siloId, fileId, object]);
    return (rows[0] as { removed: number }).removed;
  },
};
