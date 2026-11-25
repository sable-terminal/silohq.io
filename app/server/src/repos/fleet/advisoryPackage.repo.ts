// Data access for fleet.advisory_packages, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  advisoryPackageTable,
  type AdvisoryPackage,
  type AdvisoryPackagePrimaryKey,
  type NewAdvisoryPackage,
} from '../../models/fleet/advisoryPackage.model.ts';

export const advisoryPackageRepo = {
  insert(db: Queryable, row: NewAdvisoryPackage): Promise<AdvisoryPackage> {
    return insertRow(db, advisoryPackageTable, row);
  },

  findByKey(db: Queryable, key: AdvisoryPackagePrimaryKey): Promise<AdvisoryPackage | undefined> {
    return findRow(db, advisoryPackageTable, key);
  },

  remove(db: Queryable, key: AdvisoryPackagePrimaryKey): Promise<boolean> {
    return deleteRow(db, advisoryPackageTable, key);
  },

  /** The packages of these advisories, replaced by the ones given. */
  async replaceFor(db: Queryable, advisoryIds: readonly string[], rows: readonly { advisoryId: string; ecosystem: string; name: string }[]): Promise<void> {
    if (advisoryIds.length === 0) return;
    await db.query('delete from fleet.advisory_packages where advisory_id = any($1::text[])', [advisoryIds]);
    if (rows.length === 0) return;
    await db.query(
      `insert into fleet.advisory_packages (ecosystem, name, advisory_id)
       select r.ecosystem, r.name, r."advisoryId" from jsonb_to_recordset($1::jsonb) as r(ecosystem text, name text, "advisoryId" text)
       on conflict do nothing`, [JSON.stringify(rows)]);
  },
};
