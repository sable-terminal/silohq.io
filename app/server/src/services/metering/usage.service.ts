// Usage messages on metering.usage (spec 9.2), as the outbox relay publishes them: each a
// message of the outbox catalogue in its envelope { organisationId, occurredAt,
// correlationId, payload }, the outbox row id as the event id.
//
// - storage_measured (spec 67.6, 68.8, 69.7, 74.1): Siloes byte counts become rows in
//   billing.storage_measurements, each once (its point key), with storage_measured.
// - model_usage (spec 7.8, 52.6, 73.5): the provider tokens a model call consumed. Never
//   a charge: tokens are charged by operation weight at the operation's own charge step
//   (73.1, the charge contract), and a refusal, a cache hit or a rephrase is never charged
//   (73.2) whatever the provider used, so recording this as a charge would charge twice or
//   charge what must not be. It is the provider's side of the cost: for an AI FDE task,
//   the task's provider token counts are recomputed from platform.model_calls, so a
//   redelivered or reordered message changes nothing. Provider cost in pounds needs a
//   price per route, which the route data does not carry yet (README).
//
// A message that can never be recorded (malformed, naming a Silo this organisation does
// not hold) is logged and dropped rather than redelivered for ever; a failure of the
// database itself is redelivered.

import { modelUsageMessage } from '../../contracts/model-gateway/events.contract.ts';
import { storageMeasuredMessage } from '../../contracts/metering/usage.contract.ts';
import { envelopeOf, outboxMessage, type Envelope } from '../../contracts/outbox-relay/catalogue.contract.ts';
import { decode, type DurableEnvelope } from '../../infra/bus.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { storageMeasurementRepo } from '../../repos/billing/index.repo.ts';
import { fdeTaskRepo } from '../../repos/fde/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { recordEvent, type MeteringDeps } from './deps.service.ts';

/** recorded: written; duplicate: written before; noted: nothing to write (usage outside a task); dropped: never recordable. */
export type UsageOutcome = 'recorded' | 'duplicate' | 'noted' | 'dropped' | 'not_ours';

type Deps = Pick<MeteringDeps, 'databases' | 'logger'>;

export async function handleUsage(deps: Deps, message: DurableEnvelope): Promise<UsageOutcome> {
  const spec = outboxMessage('metering.usage', message.name, message.version);
  if (spec !== storageMeasuredMessage && spec !== modelUsageMessage) {
    // Another producer's message on the topic, or a version this build does not know.
    deps.logger.warn('a usage message this build does not read', { event: 'metering.usage_unknown', eventId: message.eventId });
    return 'not_ours';
  }
  const log = deps.logger.child({ eventId: message.eventId, topic: spec.topic });
  let envelope: Envelope<typeof spec.schema>;
  try {
    envelope = decode({ bus: 'durable', topic: spec.topic, name: spec.name, version: spec.version, schema: envelopeOf(spec.schema) },
      message.data) as Envelope<typeof spec.schema>;
  } catch (error) {
    log.error('a usage message does not match its schema', { event: 'metering.usage_dropped', reason: isAppError(error) ? error.code : 'schema' });
    return 'dropped';
  }
  return spec === storageMeasuredMessage
    ? recordStorage(deps, log, envelope as Envelope<typeof storageMeasuredMessage.schema>)
    : recordModelUsage(deps, envelope as Envelope<typeof modelUsageMessage.schema>);
}

async function recordStorage(deps: Deps, log: Deps['logger'], envelope: Envelope<typeof storageMeasuredMessage.schema>)
  : Promise<UsageOutcome> {
  const m = envelope.payload;
  if (m.organisationId !== envelope.organisationId) {
    log.error('a usage message names another organisation than its envelope', { event: 'metering.usage_dropped', reason: 'organisation' });
    return 'dropped';
  }
  try {
    return await inTransaction(deps.databases.pool('control'), { organisationId: m.organisationId }, async (db) => {
      const row = await storageMeasurementRepo.insertIfAbsent(db, {
        id: m.measurementId, organisationId: m.organisationId, siloId: m.siloId, store: m.store, bytesHeld: m.bytesHeld,
        bytesScanned: m.bytesScanned, bytesEgressed: m.bytesEgressed, providerCost: m.providerCost, costStorage: m.costStorage,
        costCompute: m.costCompute, costEgress: m.costEgress, period: m.period, measuredAt: m.measuredAt,
      });
      if (row === undefined) return 'duplicate';
      await recordEvent(db, {
        organisationId: m.organisationId, correlationId: envelope.correlationId, event: 'storage_measured',
        actor: { kind: 'service', service: 'metering' }, resource: { type: 'silo', id: m.siloId },
        detail: { store: m.store, period: m.period, bytes_held: m.bytesHeld, bytes_scanned: m.bytesScanned, provider_cost: m.providerCost },
      });
      return 'recorded';
    });
  } catch (error) {
    // A constraint (no such Silo here, costs that do not add up) never passes on redelivery.
    if (isAppError(error) && (error.category === 'conflict' || error.category === 'validation') && error.retryable === false) {
      log.error('a usage message cannot be recorded', { event: 'metering.usage_dropped', reason: error.code, organisationId: m.organisationId });
      return 'dropped';
    }
    throw error;
  }
}

async function recordModelUsage(deps: Deps, envelope: Envelope<typeof modelUsageMessage.schema>): Promise<UsageOutcome> {
  const usage = envelope.payload;
  if (usage.taskId === null) return 'noted';
  const task = await inTransaction(deps.databases.pool('control'), { organisationId: envelope.organisationId }, (db) =>
    fdeTaskRepo.recomputeProviderTokens(db, envelope.organisationId, usage.taskId!));
  return task === undefined ? 'noted' : 'recorded';
}
