// Data access for iam.user_identities, in plain SQL through base.repo.ts; no ORM.
// Read by silo_auth; written by silo_auth.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  userIdentityTable,
  type NewUserIdentity,
  type UserIdentity,
  type UserIdentityChanges,
} from '../../models/iam/userIdentity.model.ts';

export const userIdentityRepo = {
  insert(db: Queryable, row: NewUserIdentity): Promise<UserIdentity> {
    return insertRow(db, userIdentityTable, row);
  },

  findById(db: Queryable, id: UserIdentity['id']): Promise<UserIdentity | undefined> {
    return findRow(db, userIdentityTable, { id });
  },

  update(
    db: Queryable,
    id: UserIdentity['id'],
    changes: UserIdentityChanges,
  ): Promise<UserIdentity | undefined> {
    return updateRow(db, userIdentityTable, { id }, changes);
  },

  /** The live link for a provider's subject: how an SSO sign-in names its user (design: never by address). */
  /** A person's live link to a provider (single logout names them by it). */
  async findLiveForUser(db: Queryable, identityProviderId: string, userId: string): Promise<UserIdentity | undefined> {
    const { rows } = await db.query(
      `select ${userIdentityTable.select} from iam.user_identities where identity_provider_id = $1 and user_id = $2 and revoked_at is null limit 1`,
      [identityProviderId, userId]);
    return rows[0] as UserIdentity | undefined;
  },

  async findLive(db: Queryable, key: { organisationId: string; identityProviderId: string; subject: string }): Promise<UserIdentity | undefined> {
    const { rows } = await db.query(
      `select ${userIdentityTable.select} from iam.user_identities
        where organisation_id = $1 and identity_provider_id = $2 and subject = $3 and revoked_at is null`,
      [key.organisationId, key.identityProviderId, key.subject]);
    return rows[0] as UserIdentity | undefined;
  },

  /** The person's live identities in the organisation (RLS), with their provider's kind and issuer. */
  async listLiveForUser(db: Queryable, userId: string): Promise<(UserIdentity & { providerKind: 'saml' | 'oidc'; issuer: string })[]> {
    const { rows } = await db.query(
      `select ${userIdentityTable.select.split(', ').map((c) => `ui.${c}`).join(', ')}, ip.kind as "providerKind", ip.issuer
         from iam.user_identities ui join iam.identity_providers ip on ip.organisation_id = ui.organisation_id and ip.id = ui.identity_provider_id
        where ui.user_id = $1 and ui.revoked_at is null
        order by ui.linked_at, ui.id`, [userId]);
    return rows as (UserIdentity & { providerKind: 'saml' | 'oidc'; issuer: string })[];
  },

  /** Ends a link (decision 2026-11-14): once, by the member it belonged to. */
  async revoke(db: Queryable, id: string, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      'update iam.user_identities set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null', [id, membershipId]);
    return rowCount === 1;
  },

  async markLogin(db: Queryable, id: string): Promise<void> {
    await db.query('update iam.user_identities set last_login_at = now() where id = $1', [id]);
  },
};
