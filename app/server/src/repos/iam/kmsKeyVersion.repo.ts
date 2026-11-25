// Data access for iam.kms_key_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_auth, silo_report, silo_credential; written by no service.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { kmsKeyVersionTable, type KmsKeyVersion } from '../../models/iam/kmsKeyVersion.model.ts';

/** A sealed row a key version still wraps, with what its binding needs. */
export interface SealedReference {
  kind: 'connection_credential' | 'identity_provider' | 'mfa_factor' | 'organisation_key';
  id: string;
  organisationId: string | null;
  userId: string | null;
  connectionId: string | null;
  fieldName: string | null;
  purpose: string | null;
  rowKind: string | null;
  keyVersion: number | null;
  dekWrapped: Buffer;
}

export const kmsKeyVersionRepo = {
  findById(db: Queryable, id: KmsKeyVersion['id']): Promise<KmsKeyVersion | undefined> {
    return findRow(db, kmsKeyVersionTable, { id });
  },

  findByProviderAndKeyUriAndVersion(
    db: Queryable,
    key: Pick<KmsKeyVersion, 'provider' | 'keyUri' | 'version'>,
  ): Promise<KmsKeyVersion | undefined> {
    return findRow(db, kmsKeyVersionTable, key);
  },

  // The key-encryption key versions of these providers that may still open a secret.
  async listUsable(db: Queryable, providers: readonly KmsKeyVersion['provider'][]): Promise<KmsKeyVersion[]> {
    const { rows } = await db.query(
      `select ${kmsKeyVersionTable.select} from iam.kms_key_versions
       where status in ('active', 'decrypt_only') and provider = any($1::text[]) order by version desc`, [providers]);
    return rows as KmsKeyVersion[];
  },

  // KEK rotation (spec 61.1, 61.2), through the definer functions silo_credential alone may run.
  async startRotation(db: Queryable, provider: KmsKeyVersion['provider'], keyUri: string): Promise<{ id: string; previousId: string | null }> {
    const { rows } = await db.query('select id, previous_id as "previousId" from iam.start_key_rotation($1, $2)', [provider, keyUri]);
    return rows[0] as { id: string; previousId: string | null };
  },

  async listByStatus(db: Queryable, status: KmsKeyVersion['status']): Promise<KmsKeyVersion[]> {
    const { rows } = await db.query(`select ${kmsKeyVersionTable.select} from iam.kms_key_versions where status = $1 order by version`, [status]);
    return rows as KmsKeyVersion[];
  },

  async references(db: Queryable, keyVersionId: string, limit: number): Promise<SealedReference[]> {
    const { rows } = await db.query(
      `select kind, id, organisation_id as "organisationId", user_id as "userId", connection_id as "connectionId", field_name as "fieldName",
              purpose, row_kind as "rowKind", key_version as "keyVersion", dek_wrapped as "dekWrapped"
         from iam.key_version_references($1, $2)`, [keyVersionId, limit]);
    return rows as SealedReference[];
  },

  async rewrap(db: Queryable, ref: Pick<SealedReference, 'kind' | 'id'>, from: string, to: string, dekWrapped: Buffer): Promise<boolean> {
    const { rows } = await db.query('select iam.rewrap_sealed($1, $2, $3, $4, $5) as done', [ref.kind, ref.id, from, to, dekWrapped]);
    return (rows[0] as { done: boolean }).done;
  },

  async retire(db: Queryable, id: string): Promise<boolean> {
    const { rows } = await db.query('select iam.retire_key_version($1) as done', [id]);
    return (rows[0] as { done: boolean }).done;
  },

  /** One audit event in every organisation's log: the payload already checked against the audit message. */
  async recordForEveryOrganisation(db: Queryable, event: { name: string; version: number; topic: string }, payload: unknown, correlationId: string): Promise<number> {
    const { rows } = await db.query('select iam.record_cell_event($1, $2, $3, $4, $5) as n', [event.name, event.version, event.topic, JSON.stringify(payload), correlationId]);
    return (rows[0] as { n: number }).n;
  },
};
