// Change data capture (spec 18.1, 10.3, 10.4): a connection whose manifest streams objects
// from the database's own log, read by a Silo Agent of the connection's pool.
//
// Setting it up (stream.enable) records the capture: "Creating a slot changes the customer
// database, so it requires the connection owner's confirmation with the slot name shown."
// The caller shows the slot name (and, for Postgres, the publication) and sends them back
// confirmed; the capture names who confirmed (cdc_slot_created). An agent of the pool then
// makes the slot on first read, with the customer's read-only replication login, which the
// agent holds. A MySQL binary log keeps no slot for its readers: the agent reads it as a
// replica registered under the slot name, and only the tables the manifest streams by change
// data capture, each named with its schema (the database), leave the customer's network.
//
// Dropping it (stream.manage) stops the reader, and an agent of the pool drops the slot on
// the customer's database, then reports it (cdc_slot_dropped, naming who asked). Until then
// the slot still holds the customer's log, and the status says so.
//
// The agent's reports reach change-stream through connect-runtime, which holds the tunnel and
// the reader's lease: captured changes are decoded and published like any other source's,
// a lost slot marks the stream stale (cdc_slot_lost), and a reader's failure says why.

import { z } from 'zod';
import { CAPTURE_FAILURES, capturedChange, capturedSample, SPOOL_GAP_REASONS } from '../connect-runtime/agentTunnel.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { streamStatusView } from './stream.contract.ts';

const identifier = z.string().regex(/^[a-z0-9_]{1,63}$/, 'lower-case letters, digits and underscores, at most 63');
const connectionParams = z.strictObject({ connectionId: z.uuid() });
const MANAGERS = ['gateway', 'admin-portal'] as const;

export const setChangeCapture = defineContract({
  service: 'change-stream', name: 'setChangeCapture', method: 'POST', path: '/v1/connections/:connectionId/stream/capture',
  // Not keyed: a retry finds the capture set up (conflict).
  callers: MANAGERS, context: 'organisation', idempotency: 'none',
  params: connectionParams,
  body: z.strictObject({
    /** The replication slot the agent makes on the customer's database, as shown to the owner. */
    slotName: identifier,
    /** The publication the customer made for the captured tables: logical replication's, and only its. */
    publication: identifier.optional(),
    /** The owner saw the slot name and confirms the change to their database. */
    confirmed: z.literal(true),
  }),
  response: streamStatusView,
  status: 201,
  maxBodyBytes: 1_024,
});

export const dropChangeCapture = defineContract({
  service: 'change-stream', name: 'dropChangeCapture', method: 'POST', path: '/v1/connections/:connectionId/stream/capture/drop',
  callers: MANAGERS, context: 'organisation', idempotency: 'none',
  params: connectionParams, response: streamStatusView, maxBodyBytes: 1_024,
});

/** What the reading agent reported on a capture stream, from connect-runtime, which holds its lease. */
export const reportCapture = defineContract({
  service: 'change-stream', name: 'reportCapture', method: 'POST', path: '/v1/captures/:slotId/reports',
  callers: ['connect-runtime'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ slotId: z.uuid() }),
  body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('changes'), agentId: z.uuid(), committedAt: z.iso.datetime({ offset: true }), changes: z.array(capturedChange).max(1_000) }),
    z.strictObject({ kind: z.literal('started'), agentId: z.uuid() }),
    /** mqtt (spec 20.2, 20.6): messages from the broker, decoded here with each object's decode; values in memory only. */
    z.strictObject({
      kind: z.literal('messages'), agentId: z.uuid(),
      messages: z.array(z.strictObject({ topic: z.string().min(1).max(65_535), payload: z.string(), retained: z.boolean(), receivedAt: z.iso.datetime({ offset: true }) })).max(1_000),
    }),
    /** opcua (spec 20.3): values the server published, each naming its object, instance and browse path; values in memory only. */
    z.strictObject({ kind: z.literal('samples'), agentId: z.uuid(), samples: z.array(capturedSample).max(1_000) }),
    z.strictObject({ kind: z.literal('lost'), agentId: z.uuid() }),
    z.strictObject({ kind: z.literal('dropped'), agentId: z.uuid() }),
    z.strictObject({ kind: z.literal('failed'), agentId: z.uuid(), category: z.enum(CAPTURE_FAILURES), sqlstate: z.string().regex(/^[0-9A-Z]{5}$/).optional() }),
    z.strictObject({
      kind: z.literal('gap'), agentId: z.uuid(), reason: z.enum(SPOOL_GAP_REASONS), changes: z.int().min(0).optional(),
      from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
    }),
  ]),
  response: z.object({ accepted: z.int().min(0), discarded: z.int().min(0) }),
  maxBodyBytes: 5 * 1024 * 1024,
});
