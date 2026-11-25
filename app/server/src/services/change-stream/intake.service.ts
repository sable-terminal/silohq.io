// A provider's webhook delivery (spec 18.1, 18.8).
//
// 1. The path token routes: its SHA-256 names one active inbound endpoint in the
//    organisation the path names. An unknown, paused or revoked endpoint is not found.
// 2. The credential service verifies the delivery against the connection's sealed secret
//    with the manifest's verify expression. An unsigned, invalid or replayed delivery is
//    refused (401) and counted, and its body is never decoded; a refusal is audited at most
//    once per endpoint every 30 seconds, so a flood cannot flood the ledger.
// 3. The manifest's decode expression turns the body into changes, which are published
//    (publish.service). The stream is live again from this delivery.

import { createHash } from 'node:crypto';
import { verifyWebhookDelivery } from '../../contracts/credential/changeStream.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { lockKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import type { ChangeDeltaDraft } from '../expression-evaluator/evaluator.service.ts';
import { recordStreamEvent, type ChangeStreamDeps } from './deps.service.ts';
import { publishChanges } from './publish.service.ts';
import type { SourceCatalogue } from './sources.service.ts';
import type { StreamHealthStore } from './status.service.ts';

export interface Delivery {
  organisationId: string;
  token: string;
  payload: string;
  headers: Record<string, string>;
}

const notFound = () => new AppError('not_found', 'no such endpoint', { code: 'route.not_found' });

export const tokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export async function receiveDelivery(deps: ChangeStreamDeps, catalogue: SourceCatalogue, health: StreamHealthStore,
  delivery: Delivery, correlationId: string): Promise<{ accepted: number; discarded: number }> {
  const control = deps.databases.pool('control');
  const request = { organisationId: delivery.organisationId };
  const endpoint = await inTransaction(control, request, (db) => webhookEndpointRepo.findInbound(db, tokenHash(delivery.token)), { readOnly: true });
  if (endpoint === undefined || endpoint.status !== 'active') throw notFound();

  const verdict = await deps.services.call(verifyWebhookDelivery, {
    body: { connectionId: endpoint.connectionId, credentialId: endpoint.secretCredentialId, body: delivery.payload, headers: delivery.headers },
  }, { request, correlationId });
  if (!verdict.valid) {
    const audit = await deps.data.acquireLock(lockKeys, lockKeys.key(delivery.organisationId, { purpose: 'webhook_rejected', resourceId: endpoint.id }), 30)
      .catch(() => undefined);
    await inTransaction(control, request, async (db) => {
      await webhookEndpointRepo.countRejected(db, endpoint.id);
      if (audit !== undefined) {
        await recordStreamEvent(db, {
          organisationId: delivery.organisationId, correlationId, event: 'webhook_signature_rejected', connectionId: endpoint.connectionId,
          detail: { endpoint_id: endpoint.id, reason: verdict.reason },
        });
      }
    });
    deps.logger.warn('a webhook delivery was refused', { event: 'stream.webhook_rejected', connectionId: endpoint.connectionId, reason: verdict.reason });
    throw new AppError('unauthenticated', 'the delivery is not signed by the connection\'s secret', {
      code: 'stream.webhook_signature', details: { reason: verdict.reason },
    });
  }

  const sources = await catalogue.load(request, endpoint.connectionId);
  const block = sources.manifest.changeStream?.webhook;
  if (block === undefined || sources.connection.status !== 'active') throw notFound();
  let input: unknown = delivery.payload;
  try {
    input = JSON.parse(delivery.payload);
  } catch {
    // Not JSON: decode reads the body as text.
  }
  let drafts: ChangeDeltaDraft[];
  try {
    drafts = await compileExpression('change.decode', 'jsonata', block.decode.jsonata)
      .evaluate({ input, headers: delivery.headers, params: parametersOf(sources.connection.parameters) }, new Date()) as ChangeDeltaDraft[] ?? [];
  } catch (error) {
    deps.logger.failure('a webhook delivery did not decode', error, { event: 'stream.decode_failed', connectionId: endpoint.connectionId });
    throw new AppError('validation', 'the delivery does not decode under the connector\'s manifest', { code: 'stream.decode_failed' });
  }

  const outcome = await publishChanges(deps, sources, 'webhook', drafts ?? []);
  await inTransaction(control, request, (db) => webhookEndpointRepo.markDelivered(db, endpoint.id));
  await health.report(delivery.organisationId, endpoint.connectionId, {
    status: 'live', source: 'webhook', delivered: true, deltas: outcome.objects.size > 0,
  });
  deps.logger.info('a webhook delivery was taken', {
    event: 'stream.webhook_delivered', connectionId: endpoint.connectionId, count: outcome.accepted, rowCount: (drafts ?? []).length,
  });
  return { accepted: outcome.accepted, discarded: outcome.discarded };
}
