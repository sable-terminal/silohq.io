// Data access for connect.connection_credentials, in plain SQL through base.repo.ts; no ORM.
// Read by silo_credential; written by silo_credential.
// silo_app, silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  connectionCredentialTable,
  type ConnectionCredential,
  type ConnectionCredentialChanges,
  type NewConnectionCredential,
} from '../../models/connect/connectionCredential.model.ts';

/** What any service may know about a live credential: never a sealed column. */
export type CredentialMetadata = Pick<ConnectionCredential, 'fieldName' | 'expiresAt' | 'refreshedAt' | 'refreshFailureCount'>;

export const connectionCredentialRepo = {
  insert(db: Queryable, row: NewConnectionCredential): Promise<ConnectionCredential> {
    return insertRow(db, connectionCredentialTable, row);
  },

  findById(db: Queryable, id: ConnectionCredential['id']): Promise<ConnectionCredential | undefined> {
    return findRow(db, connectionCredentialTable, { id });
  },

  update(
    db: Queryable,
    id: ConnectionCredential['id'],
    changes: ConnectionCredentialChanges,
  ): Promise<ConnectionCredential | undefined> {
    return updateRow(db, connectionCredentialTable, { id }, changes);
  },

  /** The live rows of a connection, sealed columns included: the credential service only. */
  async liveForConnection(db: Queryable, connectionId: string): Promise<ConnectionCredential[]> {
    const { rows } = await db.query(
      `select ${connectionCredentialTable.select} from connect.connection_credentials
       where connection_id = $1 and revoked_at is null order by field_name`, [connectionId]);
    return rows as ConnectionCredential[];
  },

  /**
   * Revokes live rows and crypto-shreds them in the same statement: the sealed columns are
   * nulled as revoked_at is set, and the row stays for audit. All fields, or one.
   */
  async revokeLive(db: Queryable, connectionId: string, fieldName?: string): Promise<number> {
    const { rowCount } = await db.query(
      `update connect.connection_credentials
          set revoked_at = now(), ciphertext = null, nonce = null, dek_wrapped = null
        where connection_id = $1 and revoked_at is null and ($2::text is null or field_name = $2)`,
      [connectionId, fieldName ?? null]);
    return rowCount ?? 0;
  },

  /** Shreds one OAuth client secret (purpose oauth_client_secret): its sealed columns nulled with revoked_at. */
  async revokeClientSecret(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update connect.connection_credentials set revoked_at = now(), ciphertext = null, nonce = null, dek_wrapped = null
        where id = $1 and purpose = 'oauth_client_secret' and revoked_at is null`, [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Live secrets of a connection, through the safe view: any service may count them, none may read them. */
  async countLive(db: Queryable, connectionId: string): Promise<number> {
    const { rows } = await db.query(
      'select count(id)::int as n from connect.connection_credentials_safe where connection_id = $1 and revoked_at is null', [connectionId]);
    return (rows[0] as { n: number }).n;
  },

  /**
   * The row standing for an agent-held field (custody agent, spec 10.7): no value, so a use is
   * recorded against it. Made once; a row already there is left as it is.
   */
  async ensureAgentHeld(db: Queryable, row: Pick<NewConnectionCredential, 'id' | 'organisationId' | 'connectionId' | 'fieldName' | 'authStrategy'>): Promise<void> {
    await db.query(
      `insert into connect.connection_credentials (id, organisation_id, connection_id, purpose, field_name, custody, auth_strategy)
       values ($1, $2, $3, 'connection_auth', $4, 'agent', $5)
       on conflict (organisation_id, connection_id, field_name) where revoked_at is null and connection_id is not null do nothing`,
      [row.id, row.organisationId, row.connectionId, row.fieldName, row.authStrategy]);
  },

  /** Written in the transaction that records the unwraps (spec 61.3). */
  async markUsed(db: Queryable, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.query('update connect.connection_credentials set last_used_at = now() where id = any($1::uuid[])', [ids]);
  },

  /** A failed refresh: counted, so a run of failures surfaces as reconnect, never as an empty result. */
  async recordRefreshFailure(db: Queryable, id: string): Promise<void> {
    await db.query('update connect.connection_credentials set refresh_failure_count = refresh_failure_count + 1 where id = $1', [id]);
  },

  /** Live rows without the sealed columns, through the safe view: what any service may read. */
  async liveMetadata(db: Queryable, connectionId: string): Promise<CredentialMetadata[]> {
    const { rows } = await db.query(
      `select field_name as "fieldName", expires_at as "expiresAt", refreshed_at as "refreshedAt", refresh_failure_count as "refreshFailureCount"
       from connect.connection_credentials_safe where connection_id = $1 and revoked_at is null order by field_name`, [connectionId]);
    return rows as CredentialMetadata[];
  },

  /** Connections among these whose live credentials record a failed refresh, through the safe view (the Estate map's warning). */
  async connectionsWithRefreshFailures(db: Queryable, connectionIds: readonly string[]): Promise<string[]> {
    if (connectionIds.length === 0) return [];
    const { rows } = await db.query(
      `select distinct connection_id as id from connect.connection_credentials_safe
       where connection_id = any($1::uuid[]) and revoked_at is null and refresh_failure_count > 0`, [connectionIds]);
    return (rows as { id: string }[]).map((r) => r.id);
  },
};
