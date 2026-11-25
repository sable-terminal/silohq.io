// Data access for workspace.ask_web_policies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { SCOPES_CONTAINING_MEMBER } from './savedView.repo.ts';
import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  askWebPolicyTable,
  type AskWebPolicy,
  type AskWebPolicyChanges,
  type NewAskWebPolicy,
} from '../../models/workspace/askWebPolicy.model.ts';

export const askWebPolicyRepo = {
  insert(db: Queryable, row: NewAskWebPolicy): Promise<AskWebPolicy> {
    return insertRow(db, askWebPolicyTable, row);
  },

  findById(db: Queryable, id: AskWebPolicy['id']): Promise<AskWebPolicy | undefined> {
    return findRow(db, askWebPolicyTable, { id });
  },

  findByScopeId(
    db: Queryable,
    key: Pick<AskWebPolicy, 'organisationId' | 'scopeId'>,
  ): Promise<AskWebPolicy | undefined> {
    return findRow(db, askWebPolicyTable, key);
  },

  update(
    db: Queryable,
    id: AskWebPolicy['id'],
    changes: AskWebPolicyChanges,
  ): Promise<AskWebPolicy | undefined> {
    return updateRow(db, askWebPolicyTable, { id }, changes);
  },

  /** The policies on every scope a member sits in or under, deepest first, with each scope's depth. */
  async forMember(db: Queryable, membershipId: string): Promise<(AskWebPolicy & { depth: number })[]> {
    const { rows } = await db.query(
      `select ${askWebPolicyTable.select.split(', ').map((c) => `p.${c}`).join(', ')}, nlevel(sc.path) as depth
         from workspace.ask_web_policies p join iam.scopes sc on sc.organisation_id = p.organisation_id and sc.id = p.scope_id
        where p.scope_id in (${SCOPES_CONTAINING_MEMBER})
        order by nlevel(sc.path) desc`, [membershipId]);
    return rows as (AskWebPolicy & { depth: number })[];
  },

  /** Markings on connections owned by the scopes a member sits in or under: the marked data those scopes hold. */
  async markingsHeldFor(db: Queryable, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct rm.marking_id from gov.resource_markings rm
         join connect.connections c on c.organisation_id = rm.organisation_id and c.id = rm.connection_id
        where c.status <> 'revoked' and c.owning_scope_id in (${SCOPES_CONTAINING_MEMBER})`, [membershipId]);
    return rows.map((r) => (r as { marking_id: string }).marking_id);
  },

  /** The policies on these scopes, newest first, each with whether its scope holds marked data now. */
  async forScopes(db: Queryable, scopeIds: string[]): Promise<(AskWebPolicy & { markedData: boolean })[]> {
    const { rows } = await db.query(
      `select ${askWebPolicyTable.select.split(', ').map((c) => `p.${c}`).join(', ')},
              exists (select 1 from gov.resource_markings rm
                        join connect.connections c on c.organisation_id = rm.organisation_id and c.id = rm.connection_id
                       where c.status <> 'revoked' and c.owning_scope_id = p.scope_id) as "markedData"
         from workspace.ask_web_policies p
        where p.scope_id = any($1::uuid[])
        order by p.updated_at desc, p.id`, [scopeIds]);
    return rows as (AskWebPolicy & { markedData: boolean })[];
  },

  /** Markings on connections a scope owns. */
  async markingsHeldIn(db: Queryable, scopeId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct rm.marking_id from gov.resource_markings rm
         join connect.connections c on c.organisation_id = rm.organisation_id and c.id = rm.connection_id
        where c.status <> 'revoked' and c.owning_scope_id = $1`, [scopeId]);
    return rows.map((r) => (r as { marking_id: string }).marking_id);
  },

  async upsert(db: Queryable, row: { id: string; organisationId: string; scopeId: string; enabled: boolean; allowedDomains: string[];
    blockedDomains: string[]; markedOverrideMarkings: string[]; overrideBy: string | null; updatedBy: string }): Promise<AskWebPolicy> {
    const { rows } = await db.query(
      `insert into workspace.ask_web_policies (id, organisation_id, scope_id, enabled, allowed_domains, blocked_domains, marked_override_markings,
         override_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (organisation_id, scope_id) do update set enabled = excluded.enabled, allowed_domains = excluded.allowed_domains,
         blocked_domains = excluded.blocked_domains, marked_override_markings = excluded.marked_override_markings, override_by = excluded.override_by,
         updated_by = excluded.updated_by
       returning ${askWebPolicyTable.select}`,
      [row.id, row.organisationId, row.scopeId, row.enabled, row.allowedDomains, row.blockedDomains, row.markedOverrideMarkings, row.overrideBy, row.updatedBy]);
    return rows[0] as AskWebPolicy;
  },
};
