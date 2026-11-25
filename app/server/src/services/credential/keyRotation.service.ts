// KEK rotation (spec 61.1, 61.2, 61.9; key.rotate). A member of Silo staff holding key.rotate
// starts it, naming the new key in the cell's provider (created there by Terraform, never by
// Silo): a new key version becomes active, the active one decrypt_only. The sweep then
// re-wraps each sealed row's DEK under the new version, one transaction a row: the DEK is
// unwrapped under the old version and wrapped under the new inside the provider, with the
// row's binding and the version as context; the ciphertext is never opened. Rows sealed under
// the old version meanwhile (another process's registry has not yet moved) are swept too.
// When no live row references the old version it is retired (a guard refuses otherwise).
// key_rotation_started, key_version_retired and key_rotation_completed go to every
// organisation's audit log: each one's secrets were re-wrapped. References and counts only.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import type { KeyManagement } from '../../infra/kms.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { kmsKeyVersionRepo, type SealedReference } from '../../repos/iam/kmsKeyVersion.repo.ts';
import { sealBindings, wrapContextOf } from '../../utils/envelope.util.ts';
import { zeroise } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { organisationKeyWrapContext } from './organisationKeyStore.service.ts';

const BATCH = 200;

export interface KeyRotationDeps {
  kms: KeyManagement;
  databases: Databases;
  logger: Logger;
}

/** The context a row's DEK was wrapped with under a key version: its binding and the version. */
function contextOf(ref: SealedReference, keyVersionId: string): Buffer {
  switch (ref.kind) {
    case 'connection_credential':
      return wrapContextOf(sealBindings.connectionCredential({
        id: ref.id, organisationId: ref.organisationId!, connectionId: ref.connectionId, fieldName: ref.fieldName!, purpose: ref.purpose!,
      }), keyVersionId);
    case 'identity_provider':
      return wrapContextOf(sealBindings.identityProvider({ id: ref.id, organisationId: ref.organisationId!, kind: ref.rowKind! }), keyVersionId);
    case 'mfa_factor':
      return wrapContextOf(sealBindings.mfaFactor({ id: ref.id, userId: ref.userId!, kind: ref.rowKind! }), keyVersionId);
    case 'organisation_key':
      return organisationKeyWrapContext({ id: ref.id, organisationId: ref.organisationId!, purpose: ref.purpose as 'data' | 'hmac', version: ref.keyVersion! }, keyVersionId);
  }
}

export function createKeyRotation(deps: KeyRotationDeps) {
  const control = deps.databases.pool('control');

  async function record(name: 'key_rotation_started' | 'key_rotation_completed' | 'key_version_retired', operatorId: string | null,
    detail: Record<string, string | number | boolean | null>, correlationId: string): Promise<void> {
    const payload = auditEventMessage.schema.parse({
      event: name, actor: { kind: 'service', service: 'credential' }, subjectMembershipId: null, scopeId: null, resource: null,
      purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
      detail: { ...detail, ...(operatorId === null ? {} : { operator_id: operatorId }) },
    });
    await inTransaction(control, {}, (db) => kmsKeyVersionRepo.recordForEveryOrganisation(db, {
      name: auditEventMessage.name, version: auditEventMessage.version, topic: auditEventMessage.topic,
    }, payload, correlationId));
  }

  async function start(input: { keyUri: string; operatorId: string }, correlationId: string): Promise<{ keyVersionId: string; previousKeyVersionId: string | null }> {
    // The new key must exist in the provider and wrap: Silo never creates one.
    const verdict = await deps.kms.verifyKey(input.keyUri, 'wrap');
    if (verdict !== 'ok') {
      throw new AppError('validation', `the key is ${verdict} in the cell's provider: create it there first`, { code: 'kms.rotation_key_unusable', details: { verdict } });
    }
    let started: { id: string; previousId: string | null };
    try {
      started = await inTransaction(control, {}, (db) => kmsKeyVersionRepo.startRotation(db, deps.kms.provider as never, input.keyUri));
    } catch (error) {
      if (isAppError(error) && error.category === 'conflict') {
        throw new AppError('conflict', 'a rotation is already under way: it completes when every secret is re-wrapped', { code: 'kms.rotation_in_progress' });
      }
      throw error;
    }
    await record('key_rotation_started', input.operatorId, { key_version_id: started.id, previous_key_version_id: started.previousId }, correlationId);
    deps.logger.info('a key rotation started', { event: 'kms.rotation_started', resourceType: 'kms_key_version', resourceId: started.id });
    return { keyVersionId: started.id, previousKeyVersionId: started.previousId };
  }

  /** One round: each decrypt_only version's rows re-wrapped under the active version; a version left with none retired. */
  async function sweep(): Promise<{ rewrapped: number; retired: number }> {
    const [active] = await inTransaction(control, {}, (db) => kmsKeyVersionRepo.listByStatus(db, 'active'), { readOnly: true });
    if (active === undefined) return { rewrapped: 0, retired: 0 };
    const draining = await inTransaction(control, {}, (db) => kmsKeyVersionRepo.listByStatus(db, 'decrypt_only'), { readOnly: true });
    let rewrapped = 0;
    let retired = 0;
    const to = deps.kms.wrapper({ id: active.id, keyUri: active.keyUri });
    for (const old of draining) {
      const from = deps.kms.wrapper({ id: old.id, keyUri: old.keyUri });
      for (;;) {
        const refs = await inTransaction(control, {}, (db) => kmsKeyVersionRepo.references(db, old.id, BATCH), { readOnly: true });
        if (refs.length === 0) break;
        for (const ref of refs) {
          const dek = await from.unwrap(ref.dekWrapped, contextOf(ref, old.id));
          try {
            const wrapped = await to.wrap(dek, contextOf(ref, active.id));
            if (await inTransaction(control, {}, (db) => kmsKeyVersionRepo.rewrap(db, ref, old.id, active.id, wrapped))) rewrapped += 1;
          } finally {
            zeroise(dek);
          }
        }
      }
      if (await inTransaction(control, {}, (db) => kmsKeyVersionRepo.retire(db, old.id))) {
        retired += 1;
        const correlationId = uuidv7();
        await record('key_version_retired', null, { key_version_id: old.id }, correlationId);
        await record('key_rotation_completed', null, { key_version_id: active.id, retired_key_version_id: old.id }, correlationId);
        deps.logger.info('a key rotation completed', { event: 'kms.rotation_completed', resourceType: 'kms_key_version', resourceId: active.id });
      }
    }
    return { rewrapped, retired };
  }

  async function status(): Promise<{ versions: { id: string; keyUri: string; version: number; status: 'active' | 'decrypt_only' | 'retired'; references: number }[] }> {
    const versions = await inTransaction(control, {}, async (db) => [
      ...await kmsKeyVersionRepo.listByStatus(db, 'active'), ...await kmsKeyVersionRepo.listByStatus(db, 'decrypt_only'),
    ], { readOnly: true });
    const out = [];
    for (const v of versions) {
      const refs = v.status === 'decrypt_only' ? (await inTransaction(control, {}, (db) => kmsKeyVersionRepo.references(db, v.id, 10_000), { readOnly: true })).length : 0;
      out.push({ id: v.id, keyUri: v.keyUri, version: v.version, status: v.status, references: refs });
    }
    return { versions: out };
  }

  return { start, sweep, status };
}

export type KeyRotation = ReturnType<typeof createKeyRotation>;
