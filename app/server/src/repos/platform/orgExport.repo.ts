// Data access for platform.org_exports, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  orgExportTable,
  type NewOrgExport,
  type OrgExport,
  type OrgExportChanges,
} from '../../models/platform/orgExport.model.ts';

export const orgExportRepo = {
  insert(db: Queryable, row: NewOrgExport): Promise<OrgExport> {
    return insertRow(db, orgExportTable, row);
  },

  findById(db: Queryable, id: OrgExport['id']): Promise<OrgExport | undefined> {
    return findRow(db, orgExportTable, { id });
  },

  update(db: Queryable, id: OrgExport['id'], changes: OrgExportChanges): Promise<OrgExport | undefined> {
    return updateRow(db, orgExportTable, { id }, changes);
  },

  async listForOrganisation(db: Queryable, organisationId: string): Promise<OrgExport[]> {
    const { rows } = await db.query(
      `select ${orgExportTable.select} from platform.org_exports where organisation_id = $1 order by requested_at desc limit 100`,
      [organisationId]);
    return rows as OrgExport[];
  },

  /** Exports to run, across organisations, and running ones left by a stopped process (stale). */
  async due(db: Queryable, limit: number, staleMinutes: number): Promise<{ organisationId: string; id: string; stale: boolean }[]> {
    const { rows } = await db.query(
      `select organisation_id as "organisationId", id, stale from platform.org_exports_due($1, make_interval(mins => $2))`,
      [limit, staleMinutes]);
    return rows as { organisationId: string; id: string; stale: boolean }[];
  },
};
