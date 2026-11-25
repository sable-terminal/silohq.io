// Data access for iam.organisation_keys, in plain SQL through base.repo.ts; no ORM.
// Read by silo_credential; written by silo_credential.
// silo_app, silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  organisationKeyTable,
  type NewOrganisationKey,
  type OrganisationKey,
  type OrganisationKeyChanges,
} from '../../models/iam/organisationKey.model.ts';

export const organisationKeyRepo = {
  insert(db: Queryable, row: NewOrganisationKey): Promise<OrganisationKey> {
    return insertRow(db, organisationKeyTable, row);
  },

  findById(db: Queryable, id: OrganisationKey['id']): Promise<OrganisationKey | undefined> {
    return findRow(db, organisationKeyTable, { id });
  },

  findByPurposeAndVersion(
    db: Queryable,
    key: Pick<OrganisationKey, 'organisationId' | 'purpose' | 'version'>,
  ): Promise<OrganisationKey | undefined> {
    return findRow(db, organisationKeyTable, key);
  },

  /** The organisation's active key of a purpose (organisation_keys_active), if one exists. */
  async findActive(db: Queryable, organisationId: string, purpose: OrganisationKey['purpose']): Promise<OrganisationKey | undefined> {
    const { rows } = await db.query(
      `select ${organisationKeyTable.select} from iam.organisation_keys where organisation_id = $1 and purpose = $2 and status = 'active'`,
      [organisationId, purpose]);
    return rows[0] as OrganisationKey | undefined;
  },

  update(
    db: Queryable,
    id: OrganisationKey['id'],
    changes: OrganisationKeyChanges,
  ): Promise<OrganisationKey | undefined> {
    return updateRow(db, organisationKeyTable, { id }, changes);
  },

  /** Every key of the organisation, oldest version first (a tenant migration moves them all). */
  async listForOrganisation(db: Queryable, organisationId: string): Promise<OrganisationKey[]> {
    const { rows } = await db.query(
      `select ${organisationKeyTable.select} from iam.organisation_keys where organisation_id = $1 order by purpose, version`,
      [organisationId]);
    return rows as OrganisationKey[];
  },

  /** The highest version of a purpose so far, 0 when there is none. */
  async highestVersion(db: Queryable, organisationId: string, purpose: OrganisationKey['purpose']): Promise<number> {
    const { rows } = await db.query(
      'select coalesce(max(version), 0)::int as v from iam.organisation_keys where organisation_id = $1 and purpose = $2',
      [organisationId, purpose]);
    return (rows[0] as { v: number }).v;
  },
};
