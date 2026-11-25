// The state plane's subscription endpoints (spec 24.3, 30.1, 30.5, 30.6), called by the
// gateway for a viewer's socket. The holder is the session the gateway resolved: the
// organisation, membership, user and session context headers, never the client.
//
// open: resolves the set under the holder's own permissions, joins (or creates) the
// subscription group for its set and permission fingerprint, publishes the group's snapshot
// addressed to the subscription on bus-live (the gateway named it before calling, so the
// frame is routed), and answers with the group, the object count, the sources, and the
// fields granted and withheld by name. A subscription that would pass a bound is refused
// with the bound and limit, never partially subscribed (spec 30.5). A set whose source is not
// subscribable is refused (not_subscribable), unless an admin lets it be polled: then it is
// subscribed as polled, every N minutes, and never shown as live (decision 2026-11-15).
//
// renew: the gateway's heartbeat for its subscriptions (they lapse 60 seconds after the
// last one, spec 30.1), with the sequence each has applied. close: the viewer unsubscribed.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { setReference } from '../gateway/live.contract.ts';

const subscriptionId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const property = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const HOLDERS = ['gateway'] as const;

export const openLiveSubscription = defineContract({
  service: 'state-plane', name: 'openLiveSubscription', method: 'POST', path: '/v1/live-subscriptions',
  callers: HOLDERS, shed: 'subscription', context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    subscriptionId,
    set: setReference,
    properties: z.array(property).min(1).max(256),
    lastSeq: z.int().min(0).optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('subscribed'),
      groupId: z.uuid(),
      objectCount: z.int().min(0),
      sources: z.array(z.string()),
      fields: z.object({ granted: z.array(property), withheld: z.array(property) }),
      /** live; or polled by an admin's fallback every refreshEverySeconds, never live (decision 2026-11-15). */
      mode: z.enum(['live', 'polled']),
      refreshEverySeconds: z.int().nullable(),
    }),
    z.object({
      outcome: z.literal('refused'),
      reason: z.enum(['bound', 'unresolvable', 'permission', 'not_subscribable']),
      bound: z.string().max(64).optional(),
      limit: z.int().min(0).optional(),
      count: z.int().min(0).optional(),
    }),
  ]),
  maxBodyBytes: 32 * 1024,
});

export const closeLiveSubscription = defineContract({
  service: 'state-plane', name: 'closeLiveSubscription', method: 'POST', path: '/v1/live-subscriptions/:subscriptionId/close',
  callers: HOLDERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ subscriptionId }),
  response: z.object({ closed: z.boolean() }),
  maxBodyBytes: 1_024,
});

/** The gateway's report of a subscriber's buffer mode (spec 30.4): entering snapshot mode is audited. */
export const reportLiveBufferMode = defineContract({
  service: 'state-plane', name: 'reportLiveBufferMode', method: 'POST', path: '/v1/live-subscriptions/:subscriptionId/buffer-mode',
  callers: HOLDERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ subscriptionId }),
  body: z.strictObject({ mode: z.enum(['snapshot', 'live']) }),
  response: z.object({ recorded: z.boolean() }),
  maxBodyBytes: 1_024,
});

export const renewLiveSubscriptions = defineContract({
  service: 'state-plane', name: 'renewLiveSubscriptions', method: 'POST', path: '/v1/live-subscriptions/renewals',
  callers: HOLDERS, context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    subscriptions: z.array(z.strictObject({ subscriptionId, ackedSeq: z.int().min(0).optional() })).min(1).max(100),
  }),
  response: z.object({
    renewed: z.array(subscriptionId),
    /** No longer held (lapsed, ended by a policy change): the gateway should end them. */
    ended: z.array(subscriptionId),
  }),
  maxBodyBytes: 16 * 1024,
});
