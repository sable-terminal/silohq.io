import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';

/**
 * Machine identities and their keys.
 *
 * ONLY THE HASH OF A KEY IS EVER STORED, exactly as for sessions, invitations
 * and reset links. A key readable out of the database is one a backup, a log
 * line or a support screenshot leaks — and unlike a password, nobody notices it
 * being used.
 */

export interface ServicePrincipal {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  createdBy: string;
  disabledAt: Date | null;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  principalId: string;
  name: string;
  lastFour: string;
  createdBy: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface PrincipalRow {
  id: string;
  organisation_id: string;
  name: string;
  description: string | null;
  created_by: string;
  disabled_at: Date | null;
  created_at: Date;
}

interface KeyRow {
  id: string;
  principal_id: string;
  name: string;
  last_four: string;
  created_by: string;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

const mapPrincipal = (row: PrincipalRow): ServicePrincipal => ({
  id: row.id,
  organisationId: row.organisation_id,
  name: row.name,
  description: row.description,
  createdBy: row.created_by,
  disabledAt: row.disabled_at,
  createdAt: row.created_at,
});

const mapKey = (row: KeyRow): ApiKey => ({
  id: row.id,
  principalId: row.principal_id,
  name: row.name,
  lastFour: row.last_four,
  createdBy: row.created_by,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
});

const PRINCIPAL_COLUMNS =
  'id, organisation_id, name, description, created_by, disabled_at, created_at';
const KEY_COLUMNS =
  'id, principal_id, name, last_four, created_by, expires_at, revoked_at, last_used_at, created_at';

export async function listPrincipals(db: Executor): Promise<ServicePrincipal[]> {
  const { rows } = await db.query<PrincipalRow>(
    `SELECT ${PRINCIPAL_COLUMNS} FROM service_principals ORDER BY created_at DESC`,
  );
  return rows.map(mapPrincipal);
}

export async function findPrincipal(db: Executor, id: string): Promise<ServicePrincipal | null> {
  const { rows } = await db.query<PrincipalRow>(
    `SELECT ${PRINCIPAL_COLUMNS} FROM service_principals WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapPrincipal(rows[0]) : null;
}

export async function createPrincipal(
  db: Executor,
  input: { organisationId: string; name: string; description: string | null; createdBy: string },
): Promise<ServicePrincipal> {
  const { rows } = await db.query<PrincipalRow>(
    `INSERT INTO service_principals (id, organisation_id, name, description, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PRINCIPAL_COLUMNS}`,
    [generateId(), input.organisationId, input.name, input.description, input.createdBy],
  );
  return mapPrincipal(rows[0]!);
}

/**
 * Disable rather than delete.
 *
 * A DELETED PRINCIPAL TAKES ITS AUDIT TRAIL WITH IT — every row saying what the
 * automation did loses the thing it points at. Disabling stops every key at the
 * next request and keeps the record of what it was for.
 */
export async function setPrincipalDisabled(
  db: Executor,
  input: { id: string; disabled: boolean; by: string },
): Promise<ServicePrincipal | null> {
  const { rows } = await db.query<PrincipalRow>(
    `UPDATE service_principals
        SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, now()) ELSE NULL END,
            -- Cast explicitly: in a CASE whose other branch is NULL,
            -- Postgres has nothing to infer the parameter's type from and
            -- defaults it to text, which the uuid column then refuses.
            disabled_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END
      WHERE id = $1
      RETURNING ${PRINCIPAL_COLUMNS}`,
    [input.id, input.disabled, input.by],
  );
  return rows[0] ? mapPrincipal(rows[0]) : null;
}

export async function listKeys(db: Executor, principalId: string): Promise<ApiKey[]> {
  const { rows } = await db.query<KeyRow>(
    `SELECT ${KEY_COLUMNS} FROM api_keys WHERE principal_id = $1 ORDER BY created_at DESC`,
    [principalId],
  );
  return rows.map(mapKey);
}

export async function createKey(
  db: Executor,
  input: {
    principalId: string;
    name: string;
    tokenHash: string;
    lastFour: string;
    createdBy: string;
    expiresAt: Date;
  },
): Promise<ApiKey> {
  const { rows } = await db.query<KeyRow>(
    `INSERT INTO api_keys (id, principal_id, name, token_hash, last_four, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${KEY_COLUMNS}`,
    [
      generateId(),
      input.principalId,
      input.name,
      input.tokenHash,
      input.lastFour,
      input.createdBy,
      input.expiresAt,
    ],
  );
  return mapKey(rows[0]!);
}

export async function revokeKey(
  db: Executor,
  input: { keyId: string; by: string },
): Promise<ApiKey | null> {
  const { rows } = await db.query<KeyRow>(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()), revoked_by = $2
      WHERE id = $1
      RETURNING ${KEY_COLUMNS}`,
    [input.keyId, input.by],
  );
  return rows[0] ? mapKey(rows[0]) : null;
}

/**
 * Resolve a key to its principal, with no tenant established.
 *
 * THE KEY IS WHAT SAYS WHICH ORGANISATION IS BEING ACTED IN, so this cannot run
 * under a tenant policy — the same shape as `session_by_token`. It returns the
 * expiry, the revocation and the principal's disabled state rather than
 * filtering on them, so the caller can tell a wrong key from a withdrawn one.
 */
export interface KeyLookup {
  keyId: string;
  principalId: string;
  organisationId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  principalDisabledAt: Date | null;
}

export async function findByToken(db: Executor, tokenHash: string): Promise<KeyLookup | null> {
  const { rows } = await db.query<{
    key_id: string;
    principal_id: string;
    organisation_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    principal_disabled_at: Date | null;
  }>(`SELECT * FROM api_key_by_token($1)`, [tokenHash]);

  const row = rows[0];
  return row
    ? {
        keyId: row.key_id,
        principalId: row.principal_id,
        organisationId: row.organisation_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        principalDisabledAt: row.principal_disabled_at,
      }
    : null;
}

export async function touch(db: Executor, keyId: string): Promise<void> {
  await db.query(`SELECT touch_api_key($1)`, [keyId]);
}
