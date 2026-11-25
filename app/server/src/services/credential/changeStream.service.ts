// A connection's webhook signing secret, in the mediator (spec 18.8, 61.3).
//
// seal: the secret (the provider's, or 256 random bits Silo generates and returns once) is
//   sealed as the connection credential field webhook_signing_secret, replacing the live
//   one in the same transaction, like any other field.
// verify: the manifest's change.verify expression runs here, inside the open callback, with
//   secret.webhook in scope and reason change_stream recorded in the unwrap ledger. It gives
//   the signature the provider should have sent and the one it sent; they are compared here
//   in constant time, over their SHA-256 so lengths never show. Where the provider signs a
//   time, a delivery more than five minutes from now is refused as a replay. The caller
//   learns only valid or why not; the secret, the expected signature and the body's
//   contents never leave.

import { WEBHOOK_SECRET_FIELD, type VERIFY_REFUSALS } from '../../contracts/credential/changeStream.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { connectionCredentialRepo } from '../../repos/connect/index.repo.ts';
import { constantTimeEqual, randomBytes, sha256, zeroise } from '../../utils/crypto.util.ts';
import { lastFour, seal, sealBindings, type KeyRing } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import type { Caller, ConnectionCredentials } from './connectionCredential.service.ts';

/** Spec 18.8: deliveries signed more than five minutes from now are replays. */
export const REPLAY_WINDOW_SECONDS = 300;

export type VerifyOutcome =
  | { valid: true; signedAt?: string }
  | { valid: false; reason: (typeof VERIFY_REFUSALS)[number] };

export interface ChangeStreamCredentialDeps {
  keys: KeyRing;
  databases: Databases;
  credentials: ConnectionCredentials;
}

export function createChangeStreamCredentials(deps: ChangeStreamCredentialDeps) {
  const control = deps.databases.pool('control');

  return {
    async seal(caller: Caller, connectionId: string, given: string | undefined) {
      const loaded = await deps.credentials.load(caller, connectionId);
      if (loaded.connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no new secrets', { code: 'connection.revoked' });
      if (loaded.manifest.changeStream?.webhook === undefined) {
        throw new AppError('validation', 'the connector declares no change stream webhook', { code: 'stream.webhook_not_declared' });
      }
      const organisationId = caller.request.organisationId!;
      const generated = given === undefined ? randomBytes(32).toString('base64url') : undefined;
      const text = given ?? generated!;
      const id = uuidv7();
      const plaintext = Buffer.from(text, 'utf8');
      let sealed;
      try {
        sealed = await seal(deps.keys, plaintext, sealBindings.connectionCredential({
          id, organisationId, connectionId, fieldName: WEBHOOK_SECRET_FIELD, purpose: 'connection_auth',
        }));
      } finally {
        zeroise(plaintext);
      }
      const four = lastFour(text);
      await inTransaction(control, caller.request, async (db) => {
        await connectionCredentialRepo.revokeLive(db, connectionId, WEBHOOK_SECRET_FIELD);
        await connectionCredentialRepo.insert(db, {
          id, organisationId, connectionId, purpose: 'connection_auth', fieldName: WEBHOOK_SECRET_FIELD, custody: 'cell',
          ciphertext: sealed.ciphertext, nonce: sealed.nonce, dekWrapped: sealed.dekWrapped, keyVersionId: sealed.keyVersionId,
          lastFour: four, authStrategy: loaded.manifest.auth.strategy,
        });
        await recordConnectEvent(db, {
          service: 'credential', organisationId, correlationId: caller.correlationId, event: 'credential_sealed',
          membershipId: caller.request.membershipId, resourceType: 'credential', resourceId: id,
          detail: { connection_id: connectionId, field: WEBHOOK_SECRET_FIELD, kind: 'secret' },
        });
      });
      return { credentialId: id, lastFour: four, ...(generated === undefined ? {} : { generated }) };
    },

    async verify(caller: Caller, input: { connectionId: string; credentialId: string; body: string; headers: Record<string, string> },
      now: Date = new Date()): Promise<VerifyOutcome> {
      const loaded = await deps.credentials.load(caller, input.connectionId);
      if (loaded.connection.status !== 'active') return { valid: false, reason: 'connection_unusable' };
      const block = loaded.manifest.changeStream?.webhook;
      if (block === undefined) return { valid: false, reason: 'not_declared' };
      const row = loaded.rows.find((r) => r.id === input.credentialId && r.fieldName === WEBHOOK_SECRET_FIELD && r.custody === 'cell');
      if (row === undefined) return { valid: false, reason: 'secret_missing' };
      const params = parametersOf(loaded.connection.parameters);
      return deps.credentials.open(caller, [row], 'change_stream', async (values) => {
        const secret = { webhook: values.get(WEBHOOK_SECRET_FIELD)!.toString('utf8') };
        let result: { expected: string; provided: string; signedAt?: number };
        try {
          result = await compileExpression('change.verify', 'cel', block.verify.cel)
            .evaluate({ body: input.body, headers: input.headers, params, secret }, now) as typeof result;
        } catch {
          // A body the expression cannot read (a header it needs is absent) is unsigned.
          return { valid: false, reason: 'signature' };
        }
        if (result.provided === '' || !constantTimeEqual(sha256(result.expected), sha256(result.provided))) {
          return { valid: false, reason: 'signature' };
        }
        if (result.signedAt !== undefined) {
          if (Math.abs(now.getTime() / 1000 - result.signedAt) > REPLAY_WINDOW_SECONDS) return { valid: false, reason: 'replay' };
          return { valid: true, signedAt: new Date(result.signedAt * 1000).toISOString() };
        }
        return { valid: true };
      });
    },
  };
}

export type ChangeStreamCredentials = ReturnType<typeof createChangeStreamCredentials>;
