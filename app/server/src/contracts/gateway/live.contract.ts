// The live delta protocol (spec 30.3): one WebSocket per page through the gateway,
// authenticated by the session cookie, Zod-validated JSON at both ends.
//
// Client to server: subscribe (a set reference, the properties watched, the last
// sequence held, the client's buffer capacity), unsubscribe, ack (the sequence applied),
// resync_required (a sequence gap was seen) and heartbeat. Server to client: subscribed, refused (never a silent partial
// subscription), snapshot, delta, source_status, projection_changed, membership,
// resync_required, heartbeat and unsubscribe (the end of a subscription), plus
// buffer_mode, which tells the canvas a subscription entered or left snapshot mode under
// back-pressure (spec 30.4: "the canvas states this").
//
// Field names are camelCase like every other body of the API; the spec's example is
// written snake_case.
//
// The state plane publishes each subscription group's frames on bus-live, subject
// sub.<organisation>.<group> (spec 9.2), as liveGroupFrame: values travel only there and
// in page memory, never anywhere that persists (spec 30.7). A frame naming a subscription
// is for that subscriber alone (its snapshot); any other is for every subscriber of the
// group. The gateway readdresses each frame to the client's subscription id.

import { z } from 'zod';
import { LIMITS } from '../../config/limits.config.ts';
import { recordValue } from '../../utils/recordValue.util.ts';

export const LIVE_PATH = '/api/v1/live';

/** Close codes the client acts on: 4401 sign in again; 4403 not allowed; others reconnect with backoff. */
export const LIVE_CLOSE = {
  goingAway: 1001,
  unsupportedData: 1003,
  invalidMessage: 4400,
  sessionEnded: 4401,
  forbidden: 4403,
  heartbeatMissed: 4408,
  tooManyMessages: 4429,
  sessionUnverified: 4503,
  clientTooSlow: 4509,
} as const;

const token = /^[A-Za-z0-9_.:-]{1,128}$/;
const subscriptionId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const reference = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const property = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const objectId = z.string().regex(token);
const source = z.string().regex(token);
const sequence = z.int().min(0);
const timestamp = z.iso.datetime({ offset: true });

/** A value as a source reported it. A record value: it never leaves bus-live and page memory. */
const value = recordValue(z.union([z.string().max(64 * 1024), z.number(), z.boolean(), z.null()]));

/** What the client subscribes to. The state plane resolves it; the gateway passes it through. */
export const setReference = z.strictObject({
  kind: z.enum(['view', 'object_set']),
  id: z.uuid(),
});
export type SetReference = z.infer<typeof setReference>;

// ----------------------------------------------------------------------------- client

export const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('subscribe'),
    /** The client's name for this request, echoed on subscribed or refused. */
    ref: reference,
    set: setReference,
    properties: z.array(property).min(1).max(256),
    lastSeq: sequence.optional(),
    /** Frames the client can hold unacknowledged; lowers the high-water mark (spec 30.4). */
    bufferCapacity: z.int().min(1).max(LIMITS.statePlane.clientBufferDeltas).optional(),
  }),
  z.strictObject({ type: z.literal('unsubscribe'), sub: subscriptionId }),
  z.strictObject({ type: z.literal('ack'), sub: subscriptionId, seq: sequence }),
  /** The client saw a sequence gap; the state plane answers with resync_required and a snapshot. */
  z.strictObject({ type: z.literal('resync_required'), sub: subscriptionId, lastSeq: sequence.optional() }),
  z.strictObject({ type: z.literal('heartbeat') }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

// ----------------------------------------------------------------------------- group frames

export const visualState = z.strictObject({
  value: z.string().max(64),
  ruleVersion: z.int().min(0),
  /** The state rule's own explanation, authored with the rule. */
  reason: z.string().max(512),
});

export const change = z.strictObject({ property, value, source, receivedAt: timestamp });
export type Change = z.infer<typeof change>;

const deltaBody = {
  type: z.literal('delta'),
  seq: sequence,
  object: objectId,
  changes: z.array(change).min(1).max(256),
  state: visualState.optional(),
  coalesced: z.int().min(0),
};
const snapshotBody = {
  type: z.literal('snapshot'),
  seq: sequence,
  page: z.int().min(0),
  last: z.boolean(),
  objects: z.array(z.strictObject({
    object: objectId,
    values: z.array(z.strictObject({ property, value, source, ageMs: z.int().min(0) })).max(256),
    state: visualState.optional(),
  })).max(1_000),
};
const sourceStatusBody = {
  type: z.literal('source_status'),
  sources: z.array(z.strictObject({
    source,
    /** not_live: polled, by an admin's fallback, every refreshEverySeconds (decision 2026-11-15); ageMs is its staleness. */
    status: z.enum(['healthy', 'lagging', 'stale', 'down', 'not_live']),
    lagMs: z.int().min(0).optional(),
    ageMs: z.int().min(0).optional(),
    refreshEverySeconds: z.int().min(60).optional(),
    reason: z.string().max(256).optional(),
  })).max(256),
};
const projectionChangedBody = {
  type: z.literal('projection_changed'),
  granted: z.array(property).max(1_024),
  withheld: z.array(property).max(1_024),
};
const membershipBody = { type: z.literal('membership'), object: objectId, change: z.enum(['entered', 'left']) };
const resyncRequiredBody = { type: z.literal('resync_required') };

/** A frame for a subscription group, as the state plane publishes it. */
export const groupFrame = z.discriminatedUnion('type', [
  z.strictObject(deltaBody), z.strictObject(snapshotBody), z.strictObject(sourceStatusBody),
  z.strictObject(projectionChangedBody), z.strictObject(membershipBody), z.strictObject(resyncRequiredBody),
]);
export type GroupFrame = z.infer<typeof groupFrame>;
export type DeltaFrame = Extract<GroupFrame, { type: 'delta' }>;

/**
 * bus-live, subject sub.<organisation>.<group>. Structurally a LiveMessage
 * (infra/bus.infra.ts), declared here so publisher and consumer share it.
 */
export const liveGroupFrame = {
  bus: 'live',
  family: 'sub',
  name: 'live_group_frame',
  schema: z.strictObject({
    group: z.uuid(),
    /** Present when the frame is for one subscriber only, such as its snapshot. */
    subscription: subscriptionId.optional(),
    frame: groupFrame,
  }),
} as const;

/** bus-live, subject ctl.<organisation>.resync.<group>: a subscriber asks for a snapshot. */
export const liveResyncRequest = {
  bus: 'live',
  family: 'ctl',
  name: 'live_resync_request',
  schema: z.strictObject({ group: z.uuid(), subscription: subscriptionId, lastSeq: sequence.optional() }),
} as const;

// ----------------------------------------------------------------------------- server

/** not_subscribable: the set's source has not passed change-stream conformance, and no polling fallback is enabled (decision 2026-11-15). */
export const REFUSAL_REASONS = ['bound', 'unresolvable', 'permission', 'unavailable', 'not_subscribable'] as const;

const addressed = { sub: subscriptionId };

export const serverFrame = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('subscribed'),
    ref: reference,
    sub: subscriptionId,
    objectCount: z.int().min(0),
    sources: z.array(source).max(256),
    /** Names only (spec 30.3). */
    fields: z.strictObject({ granted: z.array(property).max(1_024), withheld: z.array(property).max(1_024) }),
    /** live; or polled every refreshEverySeconds, never live (decision 2026-11-15). */
    mode: z.enum(['live', 'polled']).optional(),
    refreshEverySeconds: z.int().min(60).optional(),
  }),
  z.strictObject({
    type: z.literal('refused'),
    ref: reference,
    reason: z.enum(REFUSAL_REASONS),
    bound: z.string().max(64).optional(),
    limit: z.int().min(0).optional(),
    count: z.int().min(0).optional(),
  }),
  z.strictObject({ ...deltaBody, ...addressed }),
  z.strictObject({ ...snapshotBody, ...addressed }),
  z.strictObject({ ...sourceStatusBody, ...addressed }),
  z.strictObject({ ...projectionChangedBody, ...addressed }),
  z.strictObject({ ...membershipBody, ...addressed }),
  z.strictObject({ ...resyncRequiredBody, ...addressed }),
  z.strictObject({ type: z.literal('buffer_mode'), sub: subscriptionId, mode: z.enum(['live', 'snapshot']) }),
  z.strictObject({ type: z.literal('unsubscribe'), sub: subscriptionId, reason: z.enum(['requested', 'ended']) }),
  z.strictObject({ type: z.literal('heartbeat'), at: timestamp }),
]);
export type ServerFrame = z.infer<typeof serverFrame>;
