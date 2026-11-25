// Outbound Action events (spec 48.3): one event per executed Action, reverts and partial
// failures included, for the customer systems that subscribe. It carries identifiers (the
// event, mutation, receipt, objects and connections), the Action type and its version, the
// object type, the fields, the outcome per connection, the people and the times; never a
// value: a subscriber reads the receipt through the API under its own permissions.
//
// The actions service writes the event to the outbox in the transaction that writes the
// receipt (topic control.action, ordered by the mutation); bus-durable carries it to notify,
// which delivers it to each active subscription whose filter it passes, signed with
// HMAC-SHA256 under the subscription's secret (held by the credential service), at least
// once, retried with backoff for 24 hours, then dead-lettered with the owner told. Events are
// not side effects and do not change a risk class.
//
// A subscription is created, paused and resumed by a holder of action.define. Its endpoint
// is HTTPS; its secret is shown once, when it is created.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const RISK = ['data', 'bulk', 'external', 'physical'] as const;
export const EVENT_OUTCOMES = ['completed', 'completed_with_divergence', 'partially_failed', 'failed', 'expired'] as const;

/** The event carries at most this many objects (the bus bounds a message); the receipt lists them all. */
export const EVENT_OBJECTS_MAX = 200;

export const actionEventPayload = z.strictObject({
  type: z.literal('action.executed'),
  mutationId: z.uuid(),
  receiptId: z.uuid(),
  origin: z.enum(['action', 'revert']),
  /** A revert: the receipt it reverts. */
  revertsReceiptId: z.uuid().nullable(),
  actionType: z.strictObject({ id: z.uuid(), versionId: z.uuid(), version: z.int().min(1) }),
  objectTypeId: z.uuid(),
  riskClass: z.enum(RISK),
  outcome: z.enum(EVENT_OUTCOMES),
  /** Source field names written. */
  fields: z.array(z.string()).max(500),
  connections: z.array(z.strictObject({
    connectionId: z.uuid(),
    outcome: z.enum(['succeeded', 'partially_succeeded', 'failed']),
    attempted: z.int().min(0),
    applied: z.int().min(0),
  })),
  objects: z.array(z.strictObject({ objectId: z.uuid(), connectionId: z.uuid(), outcome: z.enum(['verified', 'diverged', 'failed', 'not_applied']) }))
    .max(EVENT_OBJECTS_MAX),
  objectCount: z.int().min(0),
  proposer: z.uuid().nullable(),
  approvers: z.array(z.uuid()),
  executor: z.uuid().nullable(),
  proposedAt: z.string(),
  completedAt: z.string(),
});
export type ActionEventPayload = z.infer<typeof actionEventPayload>;

export const actionExecutedMessage = {
  topic: 'control.action',
  name: 'action_executed',
  version: 1,
  schema: actionEventPayload,
} as const;

/** Which events a subscription receives: every listed condition must hold; an absent one admits all. */
export const actionEventFilter = z.strictObject({
  actionTypeIds: z.array(z.uuid()).min(1).max(100).optional(),
  objectTypeIds: z.array(z.uuid()).min(1).max(100).optional(),
  riskClasses: z.array(z.enum(RISK)).min(1).optional(),
  outcomes: z.array(z.enum(EVENT_OUTCOMES)).min(1).optional(),
  origins: z.array(z.enum(['action', 'revert'])).min(1).optional(),
});
export type ActionEventFilter = z.infer<typeof actionEventFilter>;

/** Whether an event passes a subscription's filter. */
export function admits(filter: ActionEventFilter, event: ActionEventPayload): boolean {
  return (filter.actionTypeIds === undefined || filter.actionTypeIds.includes(event.actionType.id))
    && (filter.objectTypeIds === undefined || filter.objectTypeIds.includes(event.objectTypeId))
    && (filter.riskClasses === undefined || filter.riskClasses.includes(event.riskClass))
    && (filter.outcomes === undefined || filter.outcomes.includes(event.outcome))
    && (filter.origins === undefined || filter.origins.includes(event.origin));
}

export const subscriptionView = z.object({
  id: z.uuid(),
  endpointUrl: z.string(),
  filter: actionEventFilter,
  status: z.enum(['active', 'paused', 'dead_lettered']),
  statusChangedAt: z.string(),
  createdBy: z.uuid(),
  createdAt: z.string(),
  version: z.int(),
});
export type SubscriptionView = z.infer<typeof subscriptionView>;

export const createActionEventSubscription = defineContract({
  service: 'actions', name: 'createActionEventSubscription', method: 'POST', path: '/v1/action-event-subscriptions',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    endpointUrl: z.url({ protocol: /^https$/ }).max(2_048),
    filter: actionEventFilter.default({}),
  }),
  response: z.object({
    subscription: subscriptionView,
    /** The signing secret: shown once, to verify deliveries with; a repeat of the keyed request returns null. */
    secret: z.string().nullable(),
  }),
  status: 201,
});

export const listActionEventSubscriptions = defineContract({
  service: 'actions', name: 'listActionEventSubscriptions', method: 'GET', path: '/v1/action-event-subscriptions',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ subscriptions: z.array(subscriptionView) }),
});

/** Pause, or resume (a paused or dead-lettered subscription); deliveries that died stay dead. */
export const setActionEventSubscriptionStatus = defineContract({
  service: 'actions', name: 'setActionEventSubscriptionStatus', method: 'POST', path: '/v1/action-event-subscriptions/:subscriptionId/status',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ subscriptionId: z.uuid() }),
  body: z.strictObject({ status: z.enum(['active', 'paused']), version: z.int().min(1) }),
  response: subscriptionView,
});
