// Data access for iam.memberships, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  membershipTable,
  type Membership,
  type MembershipChanges,
  type NewMembership,
} from '../../models/iam/membership.model.ts';

export interface MemberSummary {
  membershipId: string;
  /** The person's name as their account holds it, through iam.member_profiles (the organisation's people only). */
  displayName: string;
  email: string;
  status: Membership['status'];
  joinedAt: string | null;
  suspendedAt: string | null;
  removedAt: string | null;
  scopeIds: string[];
}

/** A member as SCIM shows them: iam.member_profiles (the organisation's people) and the membership. */
export interface ScimProfile {
  membershipId: string;
  userId: string;
  status: Membership['status'];
  email: string;
  firstName: string;
  lastName: string;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const membershipRepo = {
  /**
   * Members in SCIM's shape, oldest first, optionally narrowed to one membership, address
   * or external id. Inside the organisation's context: the view shows only its people.
   */
  async scimProfiles(db: Queryable, filter: { membershipId?: string; email?: string; externalId?: string }, offset: number, limit: number)
    : Promise<{ total: number; profiles: ScimProfile[] }> {
    const params: unknown[] = [];
    const terms: string[] = [`m.status <> 'removed'`];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      terms.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.membershipId !== undefined) add('m.id = ?', filter.membershipId);
    if (filter.email !== undefined) add('p.email = ?::citext', filter.email);
    if (filter.externalId !== undefined) add('m.scim_external_id = ?', filter.externalId);
    const where = terms.join(' and ');
    const total = await db.query(
      `select count(*)::int as n from iam.member_profiles p join iam.memberships m on m.id = p.membership_id where ${where}`, params);
    params.push(offset, limit);
    const { rows } = await db.query(
      `select m.id as "membershipId", m.user_id as "userId", m.status, p.email::text as email, p.first_name as "firstName",
              p.last_name as "lastName", m.scim_external_id as "externalId", m.created_at as "createdAt", m.updated_at as "updatedAt"
         from iam.member_profiles p join iam.memberships m on m.id = p.membership_id
        where ${where} order by m.created_at, m.id offset $${params.length - 1} limit $${params.length}`, params);
    return { total: (total.rows[0] as { n: number }).n, profiles: rows as ScimProfile[] };
  },

  /** An active member's address, for a notification by email (iam.member_profiles, in the organisation's context). */
  async activeEmail(db: Queryable, membershipId: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `select p.email::text as email from iam.member_profiles p join iam.memberships m on m.id = p.membership_id
        where m.id = $1 and m.status = 'active'`, [membershipId]);
    return (rows[0] as { email: string } | undefined)?.email;
  },

  insert(db: Queryable, row: NewMembership): Promise<Membership> {
    return insertRow(db, membershipTable, row);
  },

  /** A user's membership of the organisation the transaction acts for. */
  async findForUser(db: Queryable, organisationId: string, userId: string): Promise<Membership | undefined> {
    const { rows } = await db.query(`select ${membershipTable.select} from iam.memberships where organisation_id = $1 and user_id = $2`, [organisationId, userId]);
    return rows[0] as Membership | undefined;
  },

  findById(db: Queryable, id: Membership['id']): Promise<Membership | undefined> {
    return findRow(db, membershipTable, { id });
  },

  findByUserId(
    db: Queryable,
    key: Pick<Membership, 'userId' | 'organisationId'>,
  ): Promise<Membership | undefined> {
    return findRow(db, membershipTable, key);
  },

  update(db: Queryable, id: Membership['id'], changes: MembershipChanges): Promise<Membership | undefined> {
    return updateRow(db, membershipTable, { id }, changes);
  },

  /**
   * Revokes every live session of a membership (suspension, removal: spec 55.7, 60.2)
   * through a definer function, since iam.sessions belongs to the auth service. Returns
   * the revoked session ids, so the caller removes their Redis copies.
   */
  async revokeSessions(db: Queryable, organisationId: string, membershipId: string): Promise<string[]> {
    const { rows } = await db.query('select id from iam.revoke_membership_sessions($1, $2) as id', [organisationId, membershipId]);
    return rows.map((row) => (row as { id: string }).id);
  },

  /** Members with the scopes they sit in; within a scope's subtree when one is named. */
  async listWithScopes(db: Queryable, filter: { withinScopeId?: string | undefined; membershipId?: string | undefined; limit: number })
    : Promise<MemberSummary[]> {
    const { rows } = await db.query(
      `select m.id as "membershipId", m.status, m.joined_at as "joinedAt", m.suspended_at as "suspendedAt",
              m.removed_at as "removedAt", btrim(p.first_name || ' ' || p.last_name) as "displayName", p.email::text as email,
              coalesce(array_agg(sm.scope_id order by sm.scope_id) filter (where sm.scope_id is not null), '{}') as "scopeIds"
       from iam.memberships m
       join iam.member_profiles p on p.membership_id = m.id
       left join iam.scope_memberships sm on sm.organisation_id = m.organisation_id and sm.membership_id = m.id
         and sm.inactive_since is null
       where ($1::uuid is null or exists (
         select 1 from iam.scope_memberships within_sm
         join iam.scopes s on s.organisation_id = within_sm.organisation_id and s.id = within_sm.scope_id
         join iam.scopes anchor on anchor.organisation_id = s.organisation_id and anchor.id = $1
         where within_sm.membership_id = m.id and within_sm.inactive_since is null and s.path <@ anchor.path))
         and ($3::uuid is null or m.id = $3)
       group by m.id, p.first_name, p.last_name, p.email order by m.created_at limit $2`, [filter.withinScopeId ?? null, filter.limit, filter.membershipId ?? null]);
    return rows as MemberSummary[];
  },

  /** The person's memberships in every organisation of this cell (RLS shows one at a time), through iam.list_user_memberships. */
  async listForUser(db: Queryable, userId: string)
    : Promise<{ membershipId: string; organisationId: string; organisationName: string; organisationSlug: string; status: 'invited' | 'active' }[]> {
    const { rows } = await db.query(
      `select membership_id as "membershipId", organisation_id as "organisationId", organisation_name as "organisationName",
              organisation_slug as "organisationSlug", membership_status as "status"
       from iam.list_user_memberships($1)`, [userId]);
    return rows as never;
  },

  /** The organisation's active memberships, by id. */
  async activeIds(db: Queryable): Promise<string[]> {
    const { rows } = await db.query(`select id from iam.memberships where status = 'active' order by id`);
    return rows.map((r) => (r as { id: string }).id);
  },
};
