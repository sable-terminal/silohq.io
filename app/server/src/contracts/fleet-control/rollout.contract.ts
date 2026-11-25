// Channels, promotion and rollouts (spec 11.2).
//
// Promotion between channels is two-person (fleet.release.promote): one release engineer
// asks, a different one approves, and only then does the channel move. Entering dev is
// one person: "every merge, internal cells only". A security fix may skip the canary
// soak when the approver, the security officer, expedites it (fleet.release.expedite).
//
// Each channel's head is a signed document with a sequence that only grows, so a cell
// can refuse an older head. Each promotion to a cell channel starts a rollout in waves;
// the cell's Fleet agent asks which release to run and reports gate verdicts. "A health
// gate failure stops the rollout and rolls the cell back automatically ... A missing
// health signal is a failure."
//
// Dedicated cells (spec 11.2 wave 5, 11.5) follow stable once its shared waves have passed,
// each in its own rollout: one wave of that cell, told in advance with the SBOM difference,
// started inside the customer's change window and not during their freeze, except for a
// security fix their change authority approved. The customer's policy reaches fleet-control
// from their cell (putCellChangePolicy), through the cell's Fleet agent.

import { z } from 'zod';
import { cellIdSchema } from '../directory/registration.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import {
  CHANNELS, digest, releaseIdSchema, signatureRecord, signedRelease, timestamp,
} from './release.contract.ts';

/** The gates of spec 11.2. A verdict missing any of them is a failure. */
export const GATES = [
  'error_rate', 'latency', 'refusal_rate', 'crash_loops', 'audit_outbox_backlog',
  'synthetic_question', 'synthetic_subscription', 'synthetic_action', 'synthetic_revert',
] as const;

export const channelHead = z.strictObject({
  schema: z.literal('silo.channel.v1'),
  channel: z.enum(CHANNELS),
  sequence: z.number().int().min(1),
  releaseId: releaseIdSchema,
  manifestDigest: digest,
  promotedAt: timestamp,
  promotionId: z.uuid(),
});

export type ChannelHead = z.infer<typeof channelHead>;

export const promotionView = z.object({
  promotionId: z.uuid(),
  releaseId: z.string(),
  channel: z.enum(CHANNELS),
  expedite: z.boolean(),
  state: z.enum(['pending', 'applied']),
  requestedBy: z.uuid(),
  requestedAt: timestamp,
  approvedBy: z.uuid().nullable(),
  appliedAt: timestamp.nullable(),
  sequence: z.number().int().nullable(),
  rolloutId: z.uuid().nullable(),
});

const sbomDifference = z.object({
  complete: z.boolean(),
  added: z.array(z.object({ subject: z.string(), purl: z.string() })),
  removed: z.array(z.object({ subject: z.string(), purl: z.string() })),
  changed: z.array(z.object({ subject: z.string(), package: z.string(), from: z.string(), to: z.string() })),
  truncated: z.boolean(),
});

/** What a dedicated cell's customer is told before a release reaches them (spec 11.5). */
export const changeNotice = z.object({
  releaseId: z.string(),
  securityFix: z.boolean(),
  /** The release before, which the cell runs until this one starts. */
  previousReleaseId: z.string().nullable(),
  noticedAt: timestamp,
  /** The earliest it may start: the notice period after noticedAt (a security fix: at once). */
  earliestStartAt: timestamp,
  /** What holds it now: the notice period, the window, a freeze; null once it may start. */
  hold: z.enum(['notice', 'window', 'freeze']).nullable(),
  sbomDifference,
});

export const rolloutView = z.object({
  rolloutId: z.uuid(),
  /** A dedicated cell's own rollout of stable; null for a channel's. */
  cellId: z.string().nullable(),
  notice: changeNotice.omit({ hold: true }).nullable(),
  channel: z.enum(CHANNELS),
  releaseId: z.string(),
  previousReleaseId: z.string().nullable(),
  sequence: z.number().int(),
  status: z.enum(['running', 'halted', 'completed', 'superseded']),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  haltReason: z.enum(['gate_failed', 'signal_missing', 'manual']).nullable(),
  haltedBy: z.uuid().nullable(),
  waves: z.array(z.object({
    cells: z.array(z.string()),
    soakHours: z.number(),
    startedAt: timestamp.nullable(),
    passedAt: timestamp.nullable(),
  })),
  verdicts: z.record(z.string(), z.object({
    releaseId: z.string(),
    verdict: z.enum(['pass', 'fail']),
    failedGates: z.array(z.string()),
    reportedAt: timestamp,
  })),
});

export type RolloutView = z.infer<typeof rolloutView>;

export const requestPromotion = defineContract({
  service: 'fleet-control', name: 'requestPromotion', method: 'PUT', path: '/v1/promotions/:promotionId',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ promotionId: z.uuid() }),
  body: z.strictObject({
    releaseId: releaseIdSchema,
    channel: z.enum(CHANNELS),
    /** A security fix skipping the canary soak; the approver expedites it (spec 11.2). */
    expedite: z.boolean().default(false),
    requestedBy: z.uuid(),
  }),
  response: promotionView,
  maxBodyBytes: 1024,
});

export const approvePromotion = defineContract({
  service: 'fleet-control', name: 'approvePromotion', method: 'PUT', path: '/v1/promotions/:promotionId/approval',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ promotionId: z.uuid() }),
  body: z.strictObject({ approvedBy: z.uuid() }),
  response: promotionView,
  maxBodyBytes: 1024,
});

/** A promotion as it stands: admin-portal reads it to ask an expedited one's approver for fleet.release.expedite. */
export const readPromotion = defineContract({
  service: 'fleet-control', name: 'readPromotion', method: 'GET', path: '/v1/promotions/:promotionId',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ promotionId: z.uuid() }),
  response: promotionView,
});

export const readChannel = defineContract({
  service: 'fleet-control', name: 'readChannel', method: 'GET', path: '/v1/channels/:channel',
  callers: ['admin-portal', 'fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ channel: z.enum(CHANNELS) }),
  response: z.object({
    channel: z.enum(CHANNELS),
    head: z.object({ document: channelHead, signatures: z.array(signatureRecord) }).nullable(),
    rolloutId: z.uuid().nullable(),
  }),
});

/** Which release this cell runs now, signed, for the cell's Fleet agent to verify and apply. */
export const desiredRelease = defineContract({
  service: 'fleet-control', name: 'desiredRelease', method: 'GET', path: '/v1/cells/:cellId/release',
  callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ cellId: cellIdSchema }),
  query: z.strictObject({ channel: z.enum(['dev', 'canary', 'stable', 'sovereign']) }),
  response: z.object({
    channel: z.enum(CHANNELS),
    releaseId: z.string().nullable(),
    /** current: the head, its rollout done; wave_started: the head; wave_pending: the release before;
     *  rolled_back: the release before, after a gate failure or a halt; none: nothing released yet.
     *  The release before may be none (releaseId null): the cell keeps what it runs. */
    reason: z.enum(['current', 'wave_started', 'wave_pending', 'rolled_back', 'none']),
    rolloutId: z.uuid().nullable(),
    release: signedRelease.nullable(),
    /** A dedicated cell: the release coming to it and what holds it, to show the customer in advance. */
    notice: changeNotice.nullable(),
  }),
});

export const reportVerdict = defineContract({
  service: 'fleet-control', name: 'reportVerdict', method: 'PUT', path: '/v1/rollouts/:rolloutId/verdicts/:cellId',
  callers: ['fleet-control'],
  // The latest verdict per cell stands; repeating one changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ rolloutId: z.uuid(), cellId: cellIdSchema }),
  body: z.strictObject({
    releaseId: releaseIdSchema,
    gates: z.array(z.strictObject({ gate: z.enum(GATES), passed: z.boolean() })).max(GATES.length * 2),
  }),
  response: rolloutView,
  maxBodyBytes: 4096,
});

export const haltRollout = defineContract({
  service: 'fleet-control', name: 'haltRollout', method: 'POST', path: '/v1/rollouts/:rolloutId/halt',
  callers: ['admin-portal'],
  // Halting a halted rollout changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ rolloutId: z.uuid() }),
  body: z.strictObject({ haltedBy: z.uuid() }),
  response: rolloutView,
  maxBodyBytes: 1024,
});

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'HH:MM, 24-hour');

/** A dedicated cell's change policy as its customer set it (spec 11.5), reported by the cell's Fleet agent. */
export const cellChangePolicy = z.strictObject({
  organisationId: z.uuid(),
  /** IANA time zone the windows are in. */
  timeZone: z.string().min(1).max(64).refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'an IANA time zone'),
  /** Weekly windows: day 1 (Monday) to 7, start and end local; an end not after the start runs past midnight. None: any time. */
  windows: z.array(z.strictObject({ day: z.int().min(1).max(7), start: hhmm, end: hhmm })).max(28),
  changeAuthorityMembershipId: z.uuid().nullable(),
  freezes: z.array(z.strictObject({ id: z.uuid(), startsAt: timestamp, endsAt: timestamp, reason: z.string().max(500) })
    .refine((f) => Date.parse(f.startsAt) < Date.parse(f.endsAt), 'a freeze ends after it starts')).max(100),
  /** The change authority's written approvals of a security fix during a freeze. */
  exceptions: z.array(z.strictObject({
    releaseId: releaseIdSchema, freezeId: z.uuid(), approvedBy: z.uuid(), approvedAt: timestamp, statement: z.string().min(1).max(4000),
  })).max(200),
});

export const putCellChangePolicy = defineContract({
  service: 'fleet-control', name: 'putCellChangePolicy', method: 'PUT', path: '/v1/cells/:cellId/change-policy',
  callers: ['fleet-control'],
  // The whole policy each time; reporting it again changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ cellId: cellIdSchema }),
  body: cellChangePolicy,
  response: z.object({ cellId: z.string(), reportedAt: timestamp, freezesSet: z.int().min(0) }),
  maxBodyBytes: 256 * 1024,
});

export const readRollout = defineContract({
  service: 'fleet-control', name: 'readRollout', method: 'GET', path: '/v1/rollouts/:rolloutId',
  callers: ['admin-portal', 'fleet-control'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ rolloutId: z.uuid() }),
  response: rolloutView,
});
