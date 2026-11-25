// change-stream's endpoints (spec 18).
//
// Management (stream.enable, stream.manage: the connection's owner, or the permission at its
// owning scope): enabling registers the connection's inbound webhook endpoint (an
// unguessable path token, which routes and does not authenticate, and the signing secret,
// sealed by the credential service), shown once; pausing, resuming and disabling the
// endpoint; rotating its secret; reading the stream's health per object.
//
// Intake: the gateway forwards a provider's delivery, unparsed, with its headers. The
// delivery is verified by the credential service before its body is decoded; an unsigned
// or invalid one is refused (401) and counted.
//
// Polling with a watermark needs no registration: it runs for objects the state plane
// holds live, at the manifest's interval, while the connection is active.
//
// Subscribable (decision 2026-11-15): an object whose stream passed the change-stream class on
// the connection's current manifest version streams live. One that did not is unavailable to
// live viewers and to Crons with change conditions, unless an admin (stream.manage) lets it be
// polled with a watermark every N minutes where the connector's rate limits allow: its clones
// then say "Not live, refreshed every N minutes", with their staleness. Each object's mode is
// in the status.

import { STREAM_TESTS } from '../conformance/changeStreamClass.contract.ts';
import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const objectName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const timestamp = z.string();

export const STREAM_STATUSES = ['live', 'delayed', 'stale', 'stopped', 'not_streamed'] as const;

export const streamStatusView = z.object({
  connectionId: z.uuid(),
  webhook: z.object({
    status: z.enum(['active', 'paused', 'revoked']),
    lastFour: z.string().nullable(),
    lastDeliveryAt: timestamp.nullable(),
    rejectedCount: z.number().int().min(0),
    createdAt: timestamp,
  }).nullable(),
  /**
   * The connection's change data capture (capture.contract.ts), where one is set up: the slot,
   * whether an agent of the pool is reading it, and the position it acknowledged last.
   * dropping: asked, and the slot still holds the customer's log until an agent drops it.
   */
  capture: z.object({
    slotId: z.uuid(),
    /** mqtt: an MQTT subscription (20.6), leased and read as a capture is. */
    method: z.enum(['logical_replication', 'binlog', 'change_tracking', 'mqtt', 'opcua']),
    slotName: z.string(),
    publication: z.string().nullable(),
    status: z.enum(['active', 'lost', 'dropping']),
    reading: z.boolean(),
    acknowledgedPosition: z.string().nullable(),
    acknowledgedAt: timestamp.nullable(),
    confirmedBy: z.uuid(),
    createdAt: timestamp,
    /**
     * The last changes lost on the way (spec 10.6): what the agent's spool dropped, or a resumed
     * reader found missing. Clones over these objects may not show them until each record
     * changes again; counts and times only.
     */
    lastGap: z.object({
      reason: z.enum(['spool_bound', 'spool_age', 'spool_damaged', 'resumed_ahead']),
      changes: z.int().nullable(),
      from: timestamp.nullable(),
      to: timestamp.nullable(),
      reportedAt: timestamp,
    }).nullable(),
  }).nullable(),
  /** Health per streamed object: the source in use and why (spec 18.7). */
  objects: z.array(z.object({
    object: objectName,
    declared: z.array(z.enum(['webhook', 'cdc', 'poll', 'email', 'mqtt', 'opcua'])),
    inUse: z.enum(['webhook', 'cdc', 'poll', 'email', 'mqtt', 'opcua', 'none']),
    status: z.enum(STREAM_STATUSES),
    lastDeltaAt: timestamp.nullable(),
    reason: z.string().nullable(),
    /** Passed the change-stream class on the connection's current manifest version. */
    subscribable: z.boolean(),
    /** live: subscribable; polled: an admin's polling fallback, never shown as live; unavailable: neither. */
    mode: z.enum(['live', 'polled', 'unavailable']),
    /** polled: how often it is refreshed. */
    refreshEverySeconds: z.int().nullable(),
    /** The change_stream run read, and the tests it did not pass. */
    conformanceRunId: z.uuid().nullable(),
    failedTests: z.array(z.enum(STREAM_TESTS)),
  })),
});
export type StreamStatusView = z.infer<typeof streamStatusView>;

const connectionParams = z.strictObject({ connectionId: z.uuid() });
const MANAGERS = ['gateway', 'admin-portal'] as const;

export const enableStream = defineContract({
  service: 'change-stream', name: 'enableStream', method: 'POST', path: '/v1/connections/:connectionId/stream',
  // Not keyed: what it shows once cannot be replayed. A retry finds the stream enabled
  // (conflict), and a lost secret is replaced by rotating it.
  callers: MANAGERS, context: 'organisation', idempotency: 'none',
  params: connectionParams,
  body: z.strictObject({
    /** The provider's own signing secret, where it issues one; absent, Silo generates one, shown once. */
    secret: z.string().min(16).max(4_096).optional(),
  }),
  response: z.object({
    stream: streamStatusView,
    /** Shown once: the path to give the provider (on the public origin), and a generated secret. */
    webhook: z.object({ path: z.string(), secret: z.string().optional() }).optional(),
    /** Email fallback: the address the system's notifications are forwarded to (spec 14.4). */
    email: z.object({ address: z.string() }).optional(),
  }),
  status: 201,
  maxBodyBytes: 16 * 1024,
});

const move = (name: 'disableStream' | 'pauseStream' | 'resumeStream', path: string) => defineContract({
  service: 'change-stream', name, method: 'POST', path: `/v1/connections/:connectionId/stream/${path}`,
  callers: MANAGERS, context: 'organisation', idempotency: 'none',
  params: connectionParams, response: streamStatusView, maxBodyBytes: 1_024,
});

/** Revokes the endpoint: the path stops routing, the secret is revoked with it. */
export const disableStream = move('disableStream', 'disable');
export const pauseStream = move('pauseStream', 'pause');
export const resumeStream = move('resumeStream', 'resume');

export const rotateWebhookSecret = defineContract({
  service: 'change-stream', name: 'rotateWebhookSecret', method: 'POST', path: '/v1/connections/:connectionId/stream/secret-rotations',
  // Not keyed, like enabling: each rotation replaces the secret, and a generated one is shown once.
  callers: MANAGERS, context: 'organisation', idempotency: 'none',
  params: connectionParams,
  body: z.strictObject({ secret: z.string().min(16).max(4_096).optional() }),
  response: z.object({ lastFour: z.string(), secret: z.string().optional() }),
  status: 201,
  maxBodyBytes: 16 * 1024,
});

/**
 * Lets a source object that is not subscribable be polled every N minutes, or stops it. The
 * object needs a declared poll source (a watermark); the interval is never shorter than the
 * manifest's, and the connection's polls, with this one, stay within a tenth of its declared
 * request rate (spec 18.4: polling shares the budget with queries).
 */
export const setPollingFallback = defineContract({
  service: 'change-stream', name: 'setPollingFallback', method: 'PUT', path: '/v1/connections/:connectionId/stream/objects/:object/polling-fallback',
  callers: MANAGERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid(), object: objectName }),
  body: z.strictObject({ enabled: z.boolean(), intervalMinutes: z.int().min(1).max(1_440).optional() })
    .refine((b) => !b.enabled || b.intervalMinutes !== undefined, 'enabling names the interval'),
  response: streamStatusView,
  maxBodyBytes: 1_024,
});

export const getStreamStatus = defineContract({
  service: 'change-stream', name: 'getStreamStatus', method: 'GET', path: '/v1/connections/:connectionId/stream',
  callers: [...MANAGERS, 'state-plane', 'canvas-layout', 'fde-orchestrator'], context: 'organisation', idempotency: 'none',
  params: connectionParams, response: streamStatusView,
});

/** The public path a provider posts to. */
export const changeHookPath = (organisationId: string, token: string): string => `/api/v1/hooks/changes/${organisationId}/${token}`;

export const receiveChangeWebhook = defineContract({
  service: 'change-stream', name: 'receiveChangeWebhook', method: 'POST', path: '/v1/change-webhooks',
  // The organisation comes from the path the provider was given; the token routes within
  // it and the signature authenticates. No person acts.
  callers: ['gateway'], context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationId: z.uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    payload: z.string().max(1024 * 1024),
    headers: z.record(z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/), z.string().max(8_192)),
  }),
  response: z.object({ accepted: z.number().int().min(0), discarded: z.number().int().min(0) }),
  status: 202,
  maxBodyBytes: 1200 * 1024,
});

/**
 * Email fallback (spec 14.4): a message the cell's mail relay received for a minted address,
 * posted whole with its signature (HMAC-SHA256 under the cell's inbound secret over the
 * recipient, a dot and the message). No person acts; the recipient's token routes.
 */
export const receiveChangeEmail = defineContract({
  service: 'change-stream', name: 'receiveChangeEmail', method: 'POST', path: '/v1/change-emails',
  callers: ['gateway'], context: 'none', idempotency: 'none',
  body: z.strictObject({
    recipient: z.string().min(3).max(320),
    message: z.string().max(1024 * 1024),
    signature: z.string().max(200),
  }),
  response: z.object({
    accepted: z.number().int().min(0),
    discarded: z.number().int().min(0),
    /** Why a message changed nothing: not from a declared sender, matching no rule, or without its record's identifier. */
    setAside: z.enum(['sender', 'no_rule', 'identifier_missing']).nullable(),
  }),
  status: 202,
  maxBodyBytes: 1200 * 1024,
});
