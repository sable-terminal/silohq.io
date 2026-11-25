// Outbound signing secrets, sealed here like any connection credential and opened only to
// sign: one per Action event subscription (contracts/credential/actionEventSecret.contract.ts,
// belonging to no connection) and one per outbound webhook target (outboundWebhookSecret, on
// the target's connection).

import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { connectionCredentialRepo } from '../../repos/connect/index.repo.ts';
import { hmacSha256, randomBytes, zeroise } from '../../utils/crypto.util.ts';
import { lastFour, seal, sealBindings, type KeyRing, type SealedSecret } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { Caller, ConnectionCredentials } from './connectionCredential.service.ts';

const FIELD = 'signing_secret';
const PURPOSE = 'action_event_secret';
type Purpose = 'action_event_secret' | 'outbound_webhook_secret';
const REASON = { action_event_secret: 'action_event', outbound_webhook_secret: 'webhook' } as const;

export interface ActionEventSecretDeps {
  keys: KeyRing;
  databases: Databases;
  credentials: ConnectionCredentials;
}

export function createActionEventSecrets(deps: ActionEventSecretDeps) {
  const control = deps.databases.pool('control');

  return {
    async create(caller: Caller, purpose: Purpose = PURPOSE, connectionId: string | null = null): Promise<{ credentialId: string; lastFour: string; secret: string }> {
      const organisationId = caller.request.organisationId!;
      const id = uuidv7();
      // A connection holds one live credential per field: each webhook target's secret is a field of its own.
      const field = purpose === PURPOSE ? FIELD : `outbound_webhook_${id}`;
      const secret = randomBytes(32).toString('base64url');
      const plaintext = Buffer.from(secret, 'utf8');
      let sealed: SealedSecret;
      try {
        sealed = await seal(deps.keys, plaintext, sealBindings.connectionCredential({ id, organisationId, connectionId, fieldName: field, purpose }));
      } finally {
        zeroise(plaintext);
      }
      await inTransaction(control, caller.request, (db) => connectionCredentialRepo.insert(db, {
        id, organisationId, connectionId, purpose, fieldName: field, custody: 'cell',
        ciphertext: sealed.ciphertext, nonce: sealed.nonce, dekWrapped: sealed.dekWrapped, keyVersionId: sealed.keyVersionId,
        lastFour: lastFour(secret), authStrategy: 'none',
      }));
      return { credentialId: id, lastFour: lastFour(secret), secret };
    },

    async sign(caller: Caller, input: { credentialId: string; timestamp: string; body: string }, purpose: Purpose = PURPOSE): Promise<{ signature: string }> {
      const row = await inTransaction(control, caller.request, (db) => connectionCredentialRepo.findById(db, input.credentialId), { readOnly: true });
      if (!row || row.revokedAt !== null || row.purpose !== purpose) {
        throw new AppError('not_found', 'no live signing secret by that reference', { code: 'credential.action_event_secret_missing' });
      }
      return deps.credentials.open(caller, [row], REASON[purpose], async (values) => {
        const key = values.get(row.fieldName)!;
        return { signature: `v1=${hmacSha256(key, `${input.timestamp}.${input.body}`).toString('hex')}` };
      });
    },
  };
}

export type ActionEventSecrets = ReturnType<typeof createActionEventSecrets>;
