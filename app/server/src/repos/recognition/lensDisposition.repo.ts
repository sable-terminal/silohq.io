// Data access for recognition.lens_dispositions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  lensDispositionTable,
  type LensDisposition,
  type LensDispositionChanges,
  type LensDispositionPrimaryKey,
  type NewLensDisposition,
} from '../../models/recognition/lensDisposition.model.ts';

export const lensDispositionRepo = {
  insert(db: Queryable, row: NewLensDisposition): Promise<LensDisposition> {
    return insertRow(db, lensDispositionTable, row);
  },

  findByKey(db: Queryable, key: LensDispositionPrimaryKey): Promise<LensDisposition | undefined> {
    return findRow(db, lensDispositionTable, key);
  },

  update(
    db: Queryable,
    key: LensDispositionPrimaryKey,
    changes: LensDispositionChanges,
  ): Promise<LensDisposition | undefined> {
    return updateRow(db, lensDispositionTable, key, changes);
  },

  async upsert(db: Queryable, row: { organisationId: string; lensId: string; findingId: string; disposition: LensDisposition['disposition']; recordedAt: string })
    : Promise<LensDisposition> {
    const { rows } = await db.query(
      `insert into recognition.lens_dispositions (organisation_id, lens_id, finding_id, disposition, recorded_at)
       values ($1, $2, $3, $4, $5)
       on conflict (organisation_id, lens_id, finding_id) do update set disposition = excluded.disposition, recorded_at = excluded.recorded_at
       returning ${lensDispositionTable.select}`, [row.organisationId, row.lensId, row.findingId, row.disposition, row.recordedAt]);
    return rows[0] as LensDisposition;
  },

  async listFor(db: Queryable, lensId: string, findingIds?: readonly string[]): Promise<LensDisposition[]> {
    const { rows } = await db.query(
      `select ${lensDispositionTable.select} from recognition.lens_dispositions
        where lens_id = $1 and ($2::uuid[] is null or finding_id = any($2::uuid[]))`, [lensId, findingIds ?? null]);
    return rows as LensDisposition[];
  },

  async counts(db: Queryable, lensIds: readonly string[]): Promise<{ lensId: string; disposition: LensDisposition['disposition']; n: number }[]> {
    if (lensIds.length === 0) return [];
    const { rows } = await db.query(
      `select lens_id as "lensId", disposition, count(*)::int as n from recognition.lens_dispositions
        where lens_id = any($1::uuid[]) group by 1, 2`, [lensIds]);
    return rows as { lensId: string; disposition: LensDisposition['disposition']; n: number }[];
  },
};
