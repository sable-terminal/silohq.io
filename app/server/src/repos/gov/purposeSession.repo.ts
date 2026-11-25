// Data access for gov.purpose_sessions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  purposeSessionTable,
  type NewPurposeSession,
  type PurposeSession,
  type PurposeSessionChanges,
} from '../../models/gov/purposeSession.model.ts';

export const purposeSessionRepo = {
  insert(db: Queryable, row: NewPurposeSession): Promise<PurposeSession> {
    return insertRow(db, purposeSessionTable, row);
  },

  findById(db: Queryable, id: PurposeSession['id']): Promise<PurposeSession | undefined> {
    return findRow(db, purposeSessionTable, { id });
  },

  update(
    db: Queryable,
    id: PurposeSession['id'],
    changes: PurposeSessionChanges,
  ): Promise<PurposeSession | undefined> {
    return updateRow(db, purposeSessionTable, { id }, changes);
  },

  /** These purpose sessions, if open and unexpired, with the purpose marking each satisfies (Postgres, the record). */
  async findLive(db: Queryable, ids: readonly string[]): Promise<(PurposeSession & { markingId: string })[]> {
    if (ids.length === 0) return [];
    const columns = purposeSessionTable.select.split(',').map((c) => `ps.${c.trim()}`).join(', ');
    const { rows } = await db.query(
      `select ${columns}, d.marking_id as "markingId" from gov.purpose_sessions ps
       join gov.purpose_definitions d on d.organisation_id = ps.organisation_id and d.id = ps.purpose_definition_id
       where ps.id = any($1::uuid[]) and ps.ended_at is null and ps.expires_at > now() and d.status = 'approved'
         and (not ps.requires_approval or ps.approved_at is not null)`, [ids]);
    return rows as (PurposeSession & { markingId: string })[];
  },

  /** Open purpose sessions of a membership, newest first. */
  async listOpen(db: Queryable, holder: { membershipId: string }): Promise<PurposeSession[]> {
    const { rows } = await db.query(
      `select ${purposeSessionTable.select} from gov.purpose_sessions
       where membership_id = $1 and ended_at is null and expires_at > now() order by declared_at desc`, [holder.membershipId]);
    return rows as PurposeSession[];
  },

  /**
   * Ends open purpose sessions in the transaction that caused it (spec 58.5): those of a
   * definition (suspended or retired), of a membership (removed, suspended), or of one
   * auth session. Returns the ended ids, so the caller deletes their Redis keys.
   */
  async endOpen(db: Queryable, which: { purposeDefinitionId: string } | { membershipId: string } | { sessionIds: readonly string[] },
    reason: NonNullable<PurposeSession['endedReason']>): Promise<string[]> {
    const [column, value] = 'purposeDefinitionId' in which ? ['purpose_definition_id = $1', which.purposeDefinitionId]
      : 'membershipId' in which ? ['membership_id = $1', which.membershipId] : ['session_id = any($1::uuid[])', which.sessionIds];
    const { rows } = await db.query(
      `update gov.purpose_sessions set ended_at = now(), ended_reason = $2 where ${column} and ended_at is null returning id`,
      [value, reason]);
    return rows.map((row) => (row as { id: string }).id);
  },

  /** After an eligibility is revoked: ends the definition's open sessions whose declarer is no longer eligible. */
  async endIneligible(db: Queryable, organisationId: string, purposeDefinitionId: string): Promise<string[]> {
    const { rows } = await db.query(
      `update gov.purpose_sessions ps set ended_at = now(), ended_reason = 'eligibility_revoked'
       where ps.organisation_id = $1 and ps.purpose_definition_id = $2 and ps.ended_at is null
         and not exists (
         select 1 from gov.purpose_eligibility e
         where e.organisation_id = $1 and e.purpose_definition_id = $2 and e.revoked_at is null
           and (e.expires_at is null or e.expires_at > now())
           and ((ps.membership_id is not null and (
                  e.grantee_membership_id = ps.membership_id
                  or e.grantee_role_id in (select ra.role_id from iam.role_assignments ra where ra.membership_id = ps.membership_id and ra.revoked_at is null and ra.silenced_at is null and (ra.expires_at is null or ra.expires_at > now()))
                  or e.grantee_scope_id in (
                    select es.id from iam.scopes es
                    join iam.scopes s on s.organisation_id = es.organisation_id and s.path <@ es.path
                    join iam.scope_memberships sm on sm.organisation_id = s.organisation_id and sm.scope_id = s.id
                    where sm.membership_id = ps.membership_id and sm.inactive_since is null)))
                or (ps.service_principal_id is not null and (
                  e.grantee_service_principal_id = ps.service_principal_id
                  or e.grantee_role_id in (select spr.role_id from iam.service_principal_roles spr where spr.service_principal_id = ps.service_principal_id)))))
       returning ps.id`, [organisationId, purposeDefinitionId]);
    return rows.map((row) => (row as { id: string }).id);
  },

  /** Approves a declaration awaiting it, once, by someone other than its declarer (D81). */
  async approve(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update gov.purpose_sessions set approved_by = $2, approved_at = now()
        where id = $1 and requires_approval and approved_at is null and ended_at is null and expires_at > now()
          and membership_id is distinct from $2`, [id, membershipId]);
    return rowCount === 1;
  },
};
