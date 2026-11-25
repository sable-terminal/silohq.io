// Data access for platform.org_export_items, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  orgExportItemTable,
  type NewOrgExportItem,
  type OrgExportItem,
  type OrgExportItemChanges,
} from '../../models/platform/orgExportItem.model.ts';

export const orgExportItemRepo = {
  insert(db: Queryable, row: NewOrgExportItem): Promise<OrgExportItem> {
    return insertRow(db, orgExportItemTable, row);
  },

  findById(db: Queryable, id: OrgExportItem['id']): Promise<OrgExportItem | undefined> {
    return findRow(db, orgExportItemTable, { id });
  },

  findByExportIdAndFamilyAndArtefactName(
    db: Queryable,
    key: Pick<OrgExportItem, 'organisationId' | 'exportId' | 'family' | 'artefactName'>,
  ): Promise<OrgExportItem | undefined> {
    return findRow(db, orgExportItemTable, key);
  },

  update(
    db: Queryable,
    id: OrgExportItem['id'],
    changes: OrgExportItemChanges,
  ): Promise<OrgExportItem | undefined> {
    return updateRow(db, orgExportItemTable, { id }, changes);
  },

  async listForExport(db: Queryable, exportId: string): Promise<OrgExportItem[]> {
    const { rows } = await db.query(
      `select ${orgExportItemTable.select} from platform.org_export_items where export_id = $1 order by family, artefact_name`, [exportId]);
    return rows as OrgExportItem[];
  },
};
