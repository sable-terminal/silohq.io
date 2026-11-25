// Data access for iam.policy_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_auth, silo_report; written by no service.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { policyVersionTable, type PolicyVersion } from '../../models/iam/policyVersion.model.ts';

export const policyVersionRepo = {
  findById(db: Queryable, id: PolicyVersion['id']): Promise<PolicyVersion | undefined> {
    return findRow(db, policyVersionTable, { id });
  },

  findByOrganisationId(
    db: Queryable,
    organisationId: PolicyVersion['organisationId'],
  ): Promise<PolicyVersion | undefined> {
    return findRow(db, policyVersionTable, { organisationId });
  },
};
