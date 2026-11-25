// Data access for workspace.scope_sharing_policies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { SCOPES_CONTAINING_MEMBER } from './savedView.repo.ts';
import {
  scopeSharingPolicyTable,
  type NewScopeSharingPolicy,
  type ScopeSharingPolicy,
  type ScopeSharingPolicyChanges,
  type ScopeSharingPolicyPrimaryKey,
} from '../../models/workspace/scopeSharingPolicy.model.ts';

const qualifiedPolicy = (alias: string): string =>
  scopeSharingPolicyTable.select.split(', ').map((column) => `${alias}.${column}`).join(', ');

export const scopeSharingPolicyRepo = {
  insert(db: Queryable, row: NewScopeSharingPolicy): Promise<ScopeSharingPolicy> {
    return insertRow(db, scopeSharingPolicyTable, row);
  },

  findByKey(db: Queryable, key: ScopeSharingPolicyPrimaryKey): Promise<ScopeSharingPolicy | undefined> {
    return findRow(db, scopeSharingPolicyTable, key);
  },

  update(
    db: Queryable,
    key: ScopeSharingPolicyPrimaryKey,
    changes: ScopeSharingPolicyChanges,
  ): Promise<ScopeSharingPolicy | undefined> {
    return updateRow(db, scopeSharingPolicyTable, key, changes);
  },

  async list(db: Queryable): Promise<ScopeSharingPolicy[]> {
    const { rows } = await db.query(`select ${scopeSharingPolicyTable.select} from workspace.scope_sharing_policies order by set_at`);
    return rows as ScopeSharingPolicy[];
  },

  /** The scope policies that bind a member: set on a scope containing one of the member's active scopes. */
  async bindingMember(db: Queryable, membershipId: string): Promise<ScopeSharingPolicy[]> {
    const { rows } = await db.query(
      `select ${qualifiedPolicy('p')} from workspace.scope_sharing_policies p
       where p.scope_id in (${SCOPES_CONTAINING_MEMBER})`, [membershipId]);
    return rows as ScopeSharingPolicy[];
  },

  /** The scope policies set on a scope's strict ancestors: its parent's effective limit. */
  async aboveScope(db: Queryable, scopeId: string): Promise<ScopeSharingPolicy[]> {
    const { rows } = await db.query(
      `select ${qualifiedPolicy('p')} from workspace.scope_sharing_policies p
       join iam.scopes anc on anc.organisation_id = p.organisation_id and anc.id = p.scope_id
       join iam.scopes s on s.organisation_id = anc.organisation_id and s.id = $1
       where s.path <@ anc.path and anc.id <> s.id`, [scopeId]);
    return rows as ScopeSharingPolicy[];
  },

  /** The scope policies set on a scope's strict descendants, which a looser setting would leave stricter. */
  async belowScope(db: Queryable, scopeId: string): Promise<ScopeSharingPolicy[]> {
    const { rows } = await db.query(
      `select ${qualifiedPolicy('p')} from workspace.scope_sharing_policies p
       join iam.scopes d on d.organisation_id = p.organisation_id and d.id = p.scope_id
       join iam.scopes s on s.organisation_id = d.organisation_id and s.id = $1
       where d.path <@ s.path and d.id <> s.id`, [scopeId]);
    return rows as ScopeSharingPolicy[];
  },
};
