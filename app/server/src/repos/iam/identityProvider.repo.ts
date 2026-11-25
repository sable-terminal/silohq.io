// Data access for iam.identity_providers, in plain SQL through base.repo.ts; no ORM.
// Read by silo_credential; written by silo_app, silo_credential.
// silo_app, silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  identityProviderTable,
  type IdentityProvider,
  type IdentityProviderChanges,
  type NewIdentityProvider,
} from '../../models/iam/identityProvider.model.ts';

export const identityProviderRepo = {
  insert(db: Queryable, row: NewIdentityProvider): Promise<IdentityProvider> {
    return insertRow(db, identityProviderTable, row);
  },

  findById(db: Queryable, id: IdentityProvider['id']): Promise<IdentityProvider | undefined> {
    return findRow(db, identityProviderTable, { id });
  },

  findByIssuer(
    db: Queryable,
    key: Pick<IdentityProvider, 'organisationId' | 'issuer'>,
  ): Promise<IdentityProvider | undefined> {
    return findRow(db, identityProviderTable, key);
  },

  update(
    db: Queryable,
    id: IdentityProvider['id'],
    changes: IdentityProviderChanges,
  ): Promise<IdentityProvider | undefined> {
    return updateRow(db, identityProviderTable, { id }, changes);
  },

  /** Replaces the configuration at the version read, moving the version on; undefined when it moved first. */
  updateAtVersion(
    db: Queryable,
    id: IdentityProvider['id'],
    version: number,
    changes: IdentityProviderChanges,
  ): Promise<IdentityProvider | undefined> {
    return updateRow(db, identityProviderTable, { id, version }, { ...changes, version: version + 1 });
  },

  /**
   * The organisation's providers without the sealed columns, which silo_app may read: for
   * the sign-in page and SSO routing (design: unique (organisation_id, issuer)).
   */
  async listPublic(db: Queryable, organisationId: string): Promise<PublicIdentityProvider[]> {
    const { rows } = await db.query(
      `select id, kind, issuer, jit_provisioning as "jitProvisioning", default_role_id as "defaultRoleId",
              default_scope_id as "defaultScopeId", active, version
         from iam.identity_providers where organisation_id = $1 order by created_at`, [organisationId]);
    return rows as PublicIdentityProvider[];
  },
};

export type PublicIdentityProvider = Pick<IdentityProvider,
  'id' | 'kind' | 'issuer' | 'jitProvisioning' | 'defaultRoleId' | 'defaultScopeId' | 'active' | 'version'>;
