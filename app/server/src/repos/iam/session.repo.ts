// Data access for iam.sessions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_auth; written by silo_auth.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  sessionTable,
  type NewSession,
  type Session,
  type SessionChanges,
} from '../../models/iam/session.model.ts';

export interface ResolvedSession {
  id: string;
  userId: string | null;
  organisationId: string | null;
  membershipId: string | null;
  issuedAt: string;
  expiresAt: string;
  authMethod: Session['authMethod'];
  mfaSatisfiedAt: string | null;
}

export const sessionRepo = {
  insert(db: Queryable, row: NewSession): Promise<Session> {
    return insertRow(db, sessionTable, row);
  },

  findById(db: Queryable, id: Session['id']): Promise<Session | undefined> {
    return findRow(db, sessionTable, { id });
  },

  findByTokenHash(db: Queryable, tokenHash: Session['tokenHash']): Promise<Session | undefined> {
    return findRow(db, sessionTable, { tokenHash });
  },

  update(db: Queryable, id: Session['id'], changes: SessionChanges): Promise<Session | undefined> {
    return updateRow(db, sessionTable, { id }, changes);
  },

  // A live session by the hash of its token (definer function: lookups by token come
  // before the user is known).
  async resolveByTokenHash(db: Queryable, tokenHash: Buffer): Promise<ResolvedSession | undefined> {
    const { rows } = await db.query(
      `select id, user_id as "userId", organisation_id as "organisationId", active_membership_id as "membershipId",
              expires_at as "expiresAt", auth_method as "authMethod", mfa_satisfied_at as "mfaSatisfiedAt", issued_at as "issuedAt"
       from iam.resolve_session($1)`,
      [tokenHash]);
    return rows[0] as ResolvedSession | undefined;
  },

  // Every live session of a membership (SCIM deprovisioning, spec 55.5). Returns the ids,
  // so their hot copies can be removed.
  async revokeForMembership(db: Queryable, organisationId: string, membershipId: string): Promise<string[]> {
    const { rows } = await db.query(
      `update iam.sessions set revoked_at = now()
        where organisation_id = $1 and active_membership_id = $2 and revoked_at is null returning id`, [organisationId, membershipId]);
    return rows.map((row) => (row as { id: string }).id);
  },

  // Every other live session of a user (a password change, spec 55.3). Returns them, so
  // their hot copies can be removed.
  async revokeOthersOfUser(db: Queryable, userId: string, keepSessionId: string): Promise<{ id: string; organisationId: string | null }[]> {
    const { rows } = await db.query(
      `update iam.sessions set revoked_at = now()
        where user_id = $1 and id <> $2 and revoked_at is null returning id, organisation_id as "organisationId"`, [userId, keepSessionId]);
    return rows as { id: string; organisationId: string | null }[];
  },

  /** Where an SSO session came from (spec 55.5): its provider and session index, for single logout. */
  async ssoOf(db: Queryable, id: string): Promise<{ userId: string; identityProviderId: string | null; ssoSessionIndex: string | null } | undefined> {
    const { rows } = await db.query(
      `select user_id as "userId", identity_provider_id as "identityProviderId", sso_session_index as "ssoSessionIndex" from iam.sessions where id = $1`, [id]);
    return rows[0] as { userId: string; identityProviderId: string | null; ssoSessionIndex: string | null } | undefined;
  },

  /** A provider's single logout: the person's live sessions from it, that session's alone where it names one. */
  async revokeForProvider(db: Queryable, userId: string, identityProviderId: string, sessionIndex: string | null): Promise<string[]> {
    const { rows } = await db.query(
      `update iam.sessions set revoked_at = now()
        where user_id = $1 and identity_provider_id = $2 and revoked_at is null and ($3::text is null or sso_session_index = $3)
        returning id`, [userId, identityProviderId, sessionIndex]);
    return rows.map((row) => (row as { id: string }).id);
  },

  // Postgres is the revocation list (spec 60.1). True when this call revoked it.
  async revoke(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query('update iam.sessions set revoked_at = now() where id = $1 and revoked_at is null', [id]);
    return rowCount === 1;
  },

  async markMfaSatisfied(db: Queryable, id: string): Promise<string | undefined> {
    const { rows } = await db.query(
      `update iam.sessions set mfa_satisfied_at = coalesce(mfa_satisfied_at, now())
       where id = $1 and revoked_at is null returning mfa_satisfied_at as "mfaSatisfiedAt"`, [id]);
    return (rows[0] as { mfaSatisfiedAt: string } | undefined)?.mfaSatisfiedAt;
  },

  // The organisation of each session, so their Redis copies can be found.
  async organisationsOf(db: Queryable, ids: readonly string[]): Promise<{ id: string; organisationId: string | null }[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query('select id, organisation_id as "organisationId" from iam.sessions where id = any($1::uuid[])', [ids]);
    return rows as { id: string; organisationId: string | null }[];
  },

  /** A live service principal session by the hash of its token (an API client's, spec 60.5), through iam.resolve_session. */
  async resolvePrincipalByTokenHash(db: Queryable, tokenHash: Buffer)
    : Promise<{ id: string; organisationId: string; servicePrincipalId: string; expiresAt: string } | undefined> {
    const { rows } = await db.query(
      `select id, organisation_id as "organisationId", service_principal_id as "servicePrincipalId", expires_at as "expiresAt"
       from iam.resolve_session($1) where service_principal_id is not null`,
      [tokenHash]);
    const row = rows[0] as { id: string; organisationId: string; servicePrincipalId: string; expiresAt: string | Date } | undefined;
    return row === undefined ? undefined : { ...row, expiresAt: new Date(row.expiresAt).toISOString() };
  },
};
