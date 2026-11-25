// Data access for siloes.silo_files, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloFileTable,
  type NewSiloFile,
  type SiloFile,
  type SiloFileChanges,
} from '../../models/siloes/siloFile.model.ts';

export const siloFileRepo = {
  insert(db: Queryable, row: NewSiloFile): Promise<SiloFile> {
    return insertRow(db, siloFileTable, row);
  },

  findById(db: Queryable, id: SiloFile['id']): Promise<SiloFile | undefined> {
    return findRow(db, siloFileTable, { id });
  },

  findByObjectStoreKey(
    db: Queryable,
    key: Pick<SiloFile, 'organisationId' | 'objectStoreKey'>,
  ): Promise<SiloFile | undefined> {
    return findRow(db, siloFileTable, key);
  },

  update(db: Queryable, id: SiloFile['id'], changes: SiloFileChanges): Promise<SiloFile | undefined> {
    return updateRow(db, siloFileTable, { id }, changes);
  },

  async listForSilo(db: Queryable, siloId: string): Promise<SiloFile[]> {
    const { rows } = await db.query(`select ${siloFileTable.select} from siloes.silo_files where silo_id = $1 order by received_at desc, id`, [siloId]);
    return rows as SiloFile[];
  },

  /** Files still held that were received before the cutoff: the retention sweep's (70.1). */
  async heldBefore(db: Queryable, siloId: string, before: string): Promise<SiloFile[]> {
    const { rows } = await db.query(
      `select ${siloFileTable.select} from siloes.silo_files where silo_id = $1 and status <> 'purged' and received_at < $2 order by received_at, id`,
      [siloId, before]);
    return rows as SiloFile[];
  },

  async bytesHeld(db: Queryable, siloId: string): Promise<string> {
    const { rows } = await db.query(
      `select coalesce(sum(size_bytes), 0)::text as bytes from siloes.silo_files where silo_id = $1 and status <> 'purged'`, [siloId]);
    return (rows[0] as { bytes: string }).bytes;
  },

  /** Files waiting to be processed, across the cell: identifiers only. */
  async toProcess(db: Queryable, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from siloes.files_to_process($1)', [limit]);
    return rows as { organisationId: string; id: string }[];
  },
};
