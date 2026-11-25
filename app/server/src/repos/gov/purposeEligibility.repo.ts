// Data access for gov.purpose_eligibility, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  purposeEligibilityTable,
  type NewPurposeEligibility,
  type PurposeEligibility,
  type PurposeEligibilityChanges,
} from '../../models/gov/purposeEligibility.model.ts';

export const purposeEligibilityRepo = {
  insert(db: Queryable, row: NewPurposeEligibility): Promise<PurposeEligibility> {
    return insertRow(db, purposeEligibilityTable, row);
  },

  findById(db: Queryable, id: PurposeEligibility['id']): Promise<PurposeEligibility | undefined> {
    return findRow(db, purposeEligibilityTable, { id });
  },

  update(
    db: Queryable,
    id: PurposeEligibility['id'],
    changes: PurposeEligibilityChanges,
  ): Promise<PurposeEligibility | undefined> {
    return updateRow(db, purposeEligibilityTable, { id }, changes);
  },

  /**
   * Whether a membership or principal may declare a purpose (spec 58.5): a live
   * eligibility names it, a role it holds, or a scope it sits in or beneath.
   */
  async isEligible(db: Queryable, organisationId: string, purposeDefinitionId: string,
    declarer: { membershipId: string | null; servicePrincipalId: string | null }): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (
         select 1 from gov.purpose_eligibility e
         where e.organisation_id = $1 and e.purpose_definition_id = $2 and e.revoked_at is null
           and (e.expires_at is null or e.expires_at > now())
           and (($3::uuid is not null and (
                  e.grantee_membership_id = $3::uuid
                  or e.grantee_role_id in (select ra.role_id from iam.role_assignments ra where ra.membership_id = $3::uuid and ra.revoked_at is null and ra.silenced_at is null and (ra.expires_at is null or ra.expires_at > now()))
                  or e.grantee_scope_id in (
                    select es.id from iam.scopes es
                    join iam.scopes s on s.organisation_id = es.organisation_id and s.path <@ es.path
                    join iam.scope_memberships sm on sm.organisation_id = s.organisation_id and sm.scope_id = s.id
                    where sm.membership_id = $3::uuid and sm.inactive_since is null)))
                or ($4::uuid is not null and (
                  e.grantee_service_principal_id = $4::uuid
                  or e.grantee_role_id in (select spr.role_id from iam.service_principal_roles spr where spr.service_principal_id = $4::uuid))))) as yes`,
      [organisationId, purposeDefinitionId, declarer.membershipId, declarer.servicePrincipalId]);
    return (rows[0] as { yes: boolean }).yes;
  },

  async list(db: Queryable, purposeDefinitionId: string): Promise<PurposeEligibility[]> {
    const { rows } = await db.query(
      `select ${purposeEligibilityTable.select} from gov.purpose_eligibility
       where purpose_definition_id = $1 and revoked_at is null order by granted_at`, [purposeDefinitionId]);
    return rows as PurposeEligibility[];
  },
};
