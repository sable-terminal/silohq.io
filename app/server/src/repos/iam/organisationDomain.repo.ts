// Data access for iam.organisation_domains, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  organisationDomainTable,
  type NewOrganisationDomain,
  type OrganisationDomain,
  type OrganisationDomainChanges,
} from '../../models/iam/organisationDomain.model.ts';

export const organisationDomainRepo = {
  insert(db: Queryable, row: NewOrganisationDomain): Promise<OrganisationDomain> {
    return insertRow(db, organisationDomainTable, row);
  },

  findById(db: Queryable, id: OrganisationDomain['id']): Promise<OrganisationDomain | undefined> {
    return findRow(db, organisationDomainTable, { id });
  },

  update(
    db: Queryable,
    id: OrganisationDomain['id'],
    changes: OrganisationDomainChanges,
  ): Promise<OrganisationDomain | undefined> {
    return updateRow(db, organisationDomainTable, { id }, changes);
  },

  /** The organisation's domains not removed, oldest first. */
  async listLive(db: Queryable): Promise<OrganisationDomain[]> {
    const { rows } = await db.query(
      `select ${organisationDomainTable.select} from iam.organisation_domains where status <> 'removed' order by created_at, id`);
    return rows as OrganisationDomain[];
  },

  /** Marks a pending domain verified, once. */
  async markVerified(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update iam.organisation_domains set status = 'verified', verified_at = now() where id = $1 and status = 'pending'`, [id]);
    return rowCount === 1;
  },

  async markRemoved(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update iam.organisation_domains set status = 'removed', removed_at = now(), removed_by = $2 where id = $1 and status <> 'removed'`,
      [id, membershipId]);
    return rowCount === 1;
  },

  /** Whether any organisation in the cell has claimed the domain (a definer function: yes or no only). */
  async claimed(db: Queryable, domain: string): Promise<boolean> {
    const { rows } = await db.query('select iam.domain_claimed($1) as claimed', [domain]);
    return (rows[0] as { claimed: boolean }).claimed;
  },
};
