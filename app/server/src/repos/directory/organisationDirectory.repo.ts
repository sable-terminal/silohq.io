// Data access for directory.organisation_directory, in plain SQL through base.repo.ts; no ORM.
// Read by directory_writer, directory_reader; written by directory_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  organisationDirectoryTable,
  type NewOrganisationDirectory,
  type OrganisationDirectory,
  type OrganisationDirectoryChanges,
} from '../../models/directory/organisationDirectory.model.ts';

export const organisationDirectoryRepo = {
  insert(db: Queryable, row: NewOrganisationDirectory): Promise<OrganisationDirectory> {
    return insertRow(db, organisationDirectoryTable, row);
  },

  findByOrganisationSlug(
    db: Queryable,
    organisationSlug: OrganisationDirectory['organisationSlug'],
  ): Promise<OrganisationDirectory | undefined> {
    return findRow(db, organisationDirectoryTable, { organisationSlug });
  },

  update(
    db: Queryable,
    organisationSlug: OrganisationDirectory['organisationSlug'],
    changes: OrganisationDirectoryChanges,
  ): Promise<OrganisationDirectory | undefined> {
    return updateRow(db, organisationDirectoryTable, { organisationSlug }, changes);
  },

  /** The entry, locked until the transaction ends, so a move and a status change serialise. */
  async findForUpdate(
    db: Queryable,
    organisationSlug: OrganisationDirectory['organisationSlug'],
  ): Promise<OrganisationDirectory | undefined> {
    const { rows } = await db.query(
      `select ${organisationDirectoryTable.select} from directory.organisation_directory where organisation_slug = $1 for update`,
      [organisationSlug]);
    return rows[0] as OrganisationDirectory | undefined;
  },
};
