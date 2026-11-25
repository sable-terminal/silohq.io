// Signing and checking execution grants (contracts/actions/grant.contract.ts). actions signs;
// connect-runtime checks before a write leaves the cell; the Go agent checks the same way.

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import {
  EXECUTION_GRANT_PREFIX, executionGrant, GRANT_LIFETIME_SECONDS, type ExecutionGrant, type GrantRefusal, type SignedExecutionGrant,
} from '../../contracts/actions/grant.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { webhookDeliveryRepo } from '../../repos/action/index.repo.ts';
import { connectionRepo, webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { instructionKeyId, signInstruction, verifyInstruction } from '../../utils/signedInstruction.util.ts';
import type { Context, WriteBackDeps } from './deps.service.ts';

/** base64url SHA-256 of a public key's SubjectPublicKeyInfo (DER). */
export const grantKeyId = instructionKeyId;

/** SHA-256, hex, of the statements as they are sent: the JSON text connect-runtime writes into the work. */
export const statementsDigest = (statements: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(statements), 'utf8').digest('hex');

export interface GrantSigner {
  readonly available: boolean;
  sign(input: Omit<ExecutionGrant, 'version' | 'grantId' | 'issuedAt' | 'expiresAt'>, now?: Date): SignedExecutionGrant;
}

/** actions' signer: none without a key (development without agents; production requires one). */
export function createGrantSigner(privateKey: KeyObject | undefined): GrantSigner {
  const keyId = privateKey === undefined ? '' : grantKeyId(createPublicKey(privateKey));
  return {
    available: privateKey !== undefined,
    sign(input, now = new Date()) {
      if (privateKey === undefined) {
        throw new AppError('configuration', 'this cell has no execution grant key: writes through the Silo Agent cannot be signed', { code: 'write.grant_unavailable' });
      }
      const grant: ExecutionGrant = executionGrant.parse({
        version: 1, grantId: uuidv7(), ...input,
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + GRANT_LIFETIME_SECONDS * 1000).toISOString(),
      });
      const json = JSON.stringify(grant);
      return { grant: json, keyId, signature: signInstruction(EXECUTION_GRANT_PREFIX, json, privateKey) };
    },
  };
}

const refused = (reason: GrantRefusal): AppError =>
  new AppError('forbidden', `the write's execution grant does not hold (${reason})`, { code: 'write.grant_refused', details: { reason } });

/** What a grant must name to cover this write. */
export interface GrantExpectation {
  organisationId: string;
  connectionId: string;
  object: string;
  statements: readonly unknown[];
  now?: Date;
}

/** The grant, if it holds for this write under this key; otherwise refused, with the reason. */
export function verifyExecutionGrant(publicKey: KeyObject, signed: SignedExecutionGrant | undefined, expect: GrantExpectation): ExecutionGrant {
  if (signed === undefined) throw refused('unsigned');
  if (signed.keyId !== grantKeyId(publicKey)) throw refused('key_unknown');
  if (!verifyInstruction(EXECUTION_GRANT_PREFIX, signed.grant, signed.signature, publicKey)) throw refused('signature');
  let parsed: unknown;
  try {
    parsed = JSON.parse(signed.grant);
  } catch {
    throw refused('signature');
  }
  const grant = executionGrant.safeParse(parsed);
  if (!grant.success) throw refused('signature');
  const g = grant.data;
  const now = (expect.now ?? new Date()).getTime();
  if (Date.parse(g.expiresAt) <= now || Date.parse(g.issuedAt) > now + 60_000) throw refused('expired');
  if (g.organisationId !== expect.organisationId) throw refused('organisation');
  if (g.connectionId !== expect.connectionId) throw refused('connection');
  if (g.object !== expect.object) throw refused('object');
  if (g.statements !== expect.statements.length) throw refused('statements');
  if (g.payloadSha256 !== statementsDigest(expect.statements)) throw refused('payload');
  return g;
}

/**
 * A grant for conformance's write class: a connection being verified is written to before
 * writes are enabled (spec 17.1). The connection is the organisation's and not revoked or halted.
 */
export async function signSandboxGrant(deps: WriteBackDeps, ctx: Context,
  input: { connectionId: string; runId: string; object: string; statements: number; payloadSha256: string }): Promise<SignedExecutionGrant> {
  const connection = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectionRepo.findById(db, input.connectionId), { readOnly: true });
  if (connection === undefined) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
  if (connection.status === 'revoked' || connection.status === 'halted') {
    throw new AppError('conflict', `a ${connection.status} connection is not written to`, { code: 'connection.not_writable' });
  }
  if (deps.grants?.available !== true) {
    throw new AppError('configuration', 'this cell has no execution grant key: writes through the Silo Agent cannot be signed', { code: 'write.grant_unavailable' });
  }
  return deps.grants.sign({
    organisationId: connection.organisationId, actionId: input.runId, actionKind: 'conformance_write_class', connectionId: input.connectionId,
    object: input.object, statements: input.statements, payloadSha256: input.payloadSha256,
  });
}

/** A grant for one attempt of a webhook delivery through the agent (spec 20.4): only while it is pending on a live agent target. */
export async function signWebhookGrant(deps: WriteBackDeps, ctx: Context, deliveryId: string, payloadSha256: string): Promise<SignedExecutionGrant> {
  const found = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const delivery = await webhookDeliveryRepo.findById(db, deliveryId);
    const endpoint = delivery === undefined ? undefined : await webhookEndpointRepo.findById(db, delivery.endpointId);
    const connection = endpoint === undefined ? undefined : await connectionRepo.findById(db, endpoint.connectionId);
    return { delivery, endpoint, connection };
  }, { readOnly: true });
  const { delivery, endpoint, connection } = found;
  if (delivery === undefined || endpoint === undefined || connection === undefined) {
    throw new AppError('not_found', 'no such webhook delivery', { code: 'webhook.delivery_not_found' });
  }
  if (delivery.status !== 'pending' || delivery.payload === null || endpoint.status !== 'active') {
    throw new AppError('conflict', 'the delivery is not waiting to be sent', { code: 'webhook.delivery_not_pending' });
  }
  if (connection.agentPoolId === null) throw new AppError('validation', 'this target is posted from the cell', { code: 'webhook.not_via_agent' });
  if (deps.grants?.available !== true) {
    throw new AppError('configuration', 'this cell has no execution grant key: writes through the Silo Agent cannot be signed', { code: 'write.grant_unavailable' });
  }
  return deps.grants.sign({
    organisationId: connection.organisationId, actionId: delivery.mutationId, actionKind: 'mutation', connectionId: connection.id,
    object: 'webhook', statements: 1, payloadSha256,
  });
}
