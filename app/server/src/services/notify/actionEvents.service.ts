// Outbound Action event delivery (spec 48.3; contracts/actions/actionEvent.contract.ts).
//
// intake: an executed Action's event, taken from bus-durable (control.action), becomes one
//   delivery per active subscription whose filter admits it, once per subscription and event
//   (the bus redelivers; the table's key keeps one).
// deliver: each due delivery is posted to its endpoint through the egress (HTTPS, public
//   addresses only), as JSON, with the event id as the idempotency key and an HMAC-SHA256
//   signature over the timestamp and body that the credential service computes under the
//   subscription's secret. A 2xx delivers it. Anything else is retried with exponential
//   backoff (30 seconds doubling, at most an hour apart) for 24 hours from the event; then
//   the delivery is dead-lettered, the subscription with it (its other pending deliveries
//   too), and its owner is told in the product. A paused subscription's deliveries wait.
// The audit log records each delivery and each dead letter; the remote's text is never kept.

import { actionEventPayload, actionExecutedMessage, admits, type ActionEventFilter } from '../../contracts/actions/actionEvent.contract.ts';
import { signActionEvent } from '../../contracts/credential/actionEventSecret.contract.ts';
import { envelopeOf, outboxMessage, type Envelope } from '../../contracts/outbox-relay/catalogue.contract.ts';
import { decode, type DurableEnvelope } from '../../infra/bus.infra.ts';
import type { Egress } from '../../infra/egress.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { actionEventDeliveryRepo, actionEventSubscriptionRepo } from '../../repos/action/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordActionEvent } from '../actions/events.service.ts';
import type { Notify } from './notify.service.ts';

export const DELIVERY = {
  /** How long an event is retried before it is dead-lettered (20.4: 24 hours). */
  windowMs: 24 * 60 * 60_000,
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  timeoutMs: 10_000,
  batch: 100,
} as const;

export interface ActionEventDeliveryDeps {
  databases: Databases;
  services: ServiceClient;
  egress: Egress;
  notify: Notify;
  logger: Logger;
}

const backoff = (attempts: number): number => Math.min(DELIVERY.baseDelayMs * 2 ** Math.max(0, attempts - 1), DELIVERY.maxDelayMs);

export function createActionEventDelivery(deps: ActionEventDeliveryDeps) {
  const control = deps.databases.pool('control');

  async function deliverOne(organisationId: string, deliveryId: string, correlationId: string, now: Date): Promise<'delivered' | 'retry' | 'dead_lettered' | 'skipped'> {
    const request = { organisationId };
    const loaded = await inTransaction(control, request, async (db) => {
      const delivery = await actionEventDeliveryRepo.findById(db, deliveryId);
      return delivery === undefined ? undefined : { delivery, subscription: (await actionEventSubscriptionRepo.findById(db, delivery.subscriptionId))! };
    }, { readOnly: true });
    if (loaded === undefined || loaded.delivery.status !== 'pending' || loaded.subscription.status !== 'active') return 'skipped';
    const { delivery, subscription } = loaded;
    const body = JSON.stringify(delivery.payload);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    let status: number | null = null;
    let error: string | null = null;
    try {
      const { signature } = await deps.services.call(signActionEvent, { body: { credentialId: subscription.secretRef, timestamp, body } }, { request, correlationId });
      const reply = await deps.egress.send({
        url: new URL(subscription.endpointUrl), method: 'POST', body, timeoutMs: DELIVERY.timeoutMs,
        headers: {
          'content-type': 'application/json', 'user-agent': 'Silo-Action-Events/1', 'idempotency-key': delivery.eventId,
          'silo-event-id': delivery.eventId, 'silo-timestamp': timestamp, 'silo-signature': signature,
        },
      });
      status = reply.status;
      if (reply.status < 200 || reply.status > 299) error = `http_${reply.status}`;
    } catch (failure) {
      error = isAppError(failure) ? failure.code.slice(0, 200) : 'delivery.failed';
    }

    const at = now.toISOString();
    const attempts = delivery.attempts + 1;
    const event = { organisationId, correlationId, request, service: 'notify' as const, resource: { type: 'action_event_subscription' as const, id: subscription.id } };
    if (error === null) {
      await inTransaction(control, request, async (db) => {
        await actionEventDeliveryRepo.update(db, delivery.id, { status: 'delivered', attempts, lastStatus: status, lastError: null, deliveredAt: at });
        await recordActionEvent(db, { ...event, event: 'action_event_delivered', detail: { mutation_id: delivery.mutationId, receipt_id: delivery.receiptId, attempts } });
      });
      return 'delivered';
    }
    if (now.getTime() - Date.parse(delivery.createdAt) < DELIVERY.windowMs) {
      await inTransaction(control, request, (db) => actionEventDeliveryRepo.update(db, delivery.id, {
        attempts, lastStatus: status, lastError: error, nextAttemptAt: new Date(now.getTime() + backoff(attempts)).toISOString(),
      }));
      return 'retry';
    }
    // The window has passed: dead-lettered, the subscription with it, and its owner told.
    await inTransaction(control, request, async (db) => {
      await actionEventDeliveryRepo.update(db, delivery.id, { status: 'dead_lettered', attempts, lastStatus: status, lastError: error, deadLetteredAt: at });
      const others = await actionEventDeliveryRepo.deadLetterPending(db, subscription.id, at);
      const current = (await actionEventSubscriptionRepo.findById(db, subscription.id))!;
      if (current.status !== 'dead_lettered') {
        await actionEventSubscriptionRepo.update(db, subscription.id, { status: 'dead_lettered', statusChangedAt: at, version: current.version + 1 });
      }
      await recordActionEvent(db, {
        ...event, event: 'action_event_dead_lettered', subjectMembershipId: subscription.createdBy,
        detail: { mutation_id: delivery.mutationId, receipt_id: delivery.receiptId, attempts, reason: error, also_dead_lettered: others },
      });
    });
    await deps.notify.raise(organisationId, {
      recipientMembershipId: subscription.createdBy, kind: 'action_event_dead_lettered', source: { actionEventSubscriptionId: subscription.id },
    });
    return 'dead_lettered';
  }

  return {
    /** An executed Action's event, from bus-durable: a delivery per admitting subscription. Other control.action messages are not ours. */
    async intake(message: DurableEnvelope): Promise<number> {
      if (message.name !== actionExecutedMessage.name) return 0;
      const spec = outboxMessage('control.action', message.name, message.version);
      if (spec === undefined) throw new AppError('validation', 'the message is not in the outbox catalogue', { code: 'notify.message_unknown' });
      const envelope = decode({ bus: 'durable', topic: spec.topic, name: spec.name, version: spec.version, schema: envelopeOf(actionEventPayload) },
        message.data) as Envelope<typeof actionEventPayload>;
      const event = envelope.payload;
      const request = { organisationId: envelope.organisationId };
      return inTransaction(control, request, async (db) => {
        let created = 0;
        for (const subscription of await actionEventSubscriptionRepo.listActive(db)) {
          if (!admits(subscription.filter as ActionEventFilter, event)) continue;
          if (await actionEventDeliveryRepo.insertOnce(db, {
            id: uuidv7(), organisationId: envelope.organisationId, subscriptionId: subscription.id, eventId: message.eventId,
            mutationId: event.mutationId, receiptId: event.receiptId, payload: { id: message.eventId, ...event } as never,
          })) created += 1;
        }
        return created;
      });
    },

    /** The deliveries due now, across organisations, each under its own organisation. */
    async deliverDue(correlationId: string, now: Date = new Date()): Promise<{ delivered: number; retried: number; deadLettered: number }> {
      const due = await inTransaction(control, {}, (db) => actionEventDeliveryRepo.due(db, now.toISOString(), DELIVERY.batch), { readOnly: true });
      const out = { delivered: 0, retried: 0, deadLettered: 0 };
      for (const d of due) {
        try {
          const outcome = await deliverOne(d.organisationId, d.id, correlationId, now);
          if (outcome === 'delivered') out.delivered += 1;
          else if (outcome === 'retry') out.retried += 1;
          else if (outcome === 'dead_lettered') out.deadLettered += 1;
        } catch (error) {
          deps.logger.failure('an Action event delivery could not be recorded; it is tried again', error, { event: 'notify.action_event_failed', organisationId: d.organisationId });
        }
      }
      return out;
    },
  };
}

export type ActionEventDelivery = ReturnType<typeof createActionEventDelivery>;
