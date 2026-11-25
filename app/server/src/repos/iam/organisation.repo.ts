// Data access for iam.organisations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  organisationTable,
  type NewOrganisation,
  type Organisation,
  type OrganisationChanges,
} from '../../models/iam/organisation.model.ts';

export interface LoginOrganisation {
  id: string;
  status: Organisation['status'];
  mfaRequired: boolean;
  ssoRequired: boolean;
  sessionIdleMinutes: number | null;
  sessionAbsoluteMinutes: number | null;
}

export const organisationRepo = {
  insert(db: Queryable, row: NewOrganisation): Promise<Organisation> {
    return insertRow(db, organisationTable, row);
  },

  findById(db: Queryable, id: Organisation['id']): Promise<Organisation | undefined> {
    return findRow(db, organisationTable, { id });
  },

  findBySlug(db: Queryable, slug: Organisation['slug']): Promise<Organisation | undefined> {
    return findRow(db, organisationTable, { slug });
  },

  update(
    db: Queryable,
    id: Organisation['id'],
    changes: OrganisationChanges,
  ): Promise<Organisation | undefined> {
    return updateRow(db, organisationTable, { id }, changes);
  },

  // The organisation a login names, by slug, before app.org_id can be set (definer function).
  async findForLogin(db: Queryable, slug: string): Promise<LoginOrganisation | undefined> {
    const { rows } = await db.query(
      `select id, status, mfa_required as "mfaRequired", sso_required as "ssoRequired",
              session_idle_minutes as "sessionIdleMinutes", session_absolute_minutes as "sessionAbsoluteMinutes"
       from iam.find_organisation_for_login($1)`, [slug]);
    return rows[0] as LoginOrganisation | undefined;
  },

  // The organisation's billing status, locked while the billing service changes it.
  async lockBillingStatus(db: Queryable, id: string): Promise<Organisation['billingStatus'] | undefined> {
    const { rows } = await db.query('select billing_status as "billingStatus" from iam.organisations where id = $1 for update', [id]);
    return (rows[0] as { billingStatus: Organisation['billingStatus'] } | undefined)?.billingStatus;
  },

  /** The organisation's plan: Enterprise once a contract is active (spec 71.2). */
  async setPlan(db: Queryable, id: string, plan: Organisation['plan']): Promise<boolean> {
    const { rowCount } = await db.query('update iam.organisations set plan = $2 where id = $1 and plan <> $2', [id, plan]);
    return rowCount === 1;
  },

  // Billing status is written only by the billing service, from a verified payment webhook
  // or a staff path (spec 75.3), through the silo_billing role's column grant.
  async setBillingStatus(db: Queryable, id: string, status: Organisation['billingStatus']): Promise<boolean> {
    const { rowCount } = await db.query('update iam.organisations set billing_status = $2 where id = $1', [id, status]);
    return rowCount === 1;
  },

  /**
   * The cell's system organisation (review D10), which holds Silo-owned secrets such as
   * Silo-registered OAuth clients. Through a definer function: row-level security shows a
   * service only the organisation it acts for.
   */
  async systemOrganisationId(db: Queryable): Promise<string | undefined> {
    const { rows } = await db.query('select iam.system_organisation_id() as id');
    return (rows[0] as { id: string | null } | undefined)?.id ?? undefined;
  },

  /** The cell's synthetic organisation (spec 11.2), where the release gates' tests run; through a definer function. */
  async syntheticOrganisationId(db: Queryable): Promise<string | undefined> {
    const { rows } = await db.query('select iam.synthetic_organisation_id() as id');
    return (rows[0] as { id: string | null } | undefined)?.id ?? undefined;
  },

  /** The synthetic organisation's members by the part each plays (definer function: row-level security hides users). */
  async syntheticMembers(db: Queryable): Promise<{ member: string; membershipId: string; userId: string }[]> {
    const { rows } = await db.query('select member, membership_id as "membershipId", user_id as "userId" from iam.synthetic_members()');
    return rows as { member: string; membershipId: string; userId: string }[];
  },

  /** An organisation as Silo staff name it, by slug: identity and standing only (definer function). */
  async findForStaff(db: Queryable, slug: string): Promise<StaffOrganisation | undefined> {
    const { rows } = await db.query(
      `select id, name, slug, plan, status, billing_status as "billingStatus", cell_id as "cellId",
              operator_access_approval_required as "operatorAccessApprovalRequired"
       from platform.organisation_for_staff($1)`, [slug]);
    return rows[0] as StaffOrganisation | undefined;
  },
};

export type StaffOrganisation = Pick<Organisation, 'id' | 'name' | 'slug' | 'plan' | 'status' | 'billingStatus' | 'cellId'
  | 'operatorAccessApprovalRequired'>;
