// Stream probes (decision 2026-11-15): how the conformance service watches a connection's
// change stream for one test record while it runs the change-stream class.
//
// open: the object must be streamed. The source tested is the one in use, in the manifest's
// order of preference: a webhook while its endpoint is active, else polling with a watermark.
// Where a poll source is declared, the watermark standing now is kept as the probe's
// baseline, so a later read can resume from it. A probe lives 15 minutes.
//
// read, for the test record (its identifier and the fields the edits change):
//   observe          (polling) reads past the probe's own watermark, as the poller does, and
//                    publishes what it finds through the same path; (webhook) the provider's
//                    deliveries are taken as they come. Answers every change seen for the
//                    record since the probe first read, in arrival order.
//   resume           reads again from the baseline: answers the changes that read produced.
//   replay           offers the record's changes again: from the baseline (polling), or by
//                    their de-duplication keys (webhook). Answers each, marked duplicate
//                    where it was discarded as a repeat.
//   forged_delivery  (webhook) a delivery not signed with the connection's secret, verified
//                    by the credential service: answers whether it was refused.
// An observation carries the operation, the source sequence, whether it was a duplicate, and
// a digest (SHA-256) of the named fields' values, so the caller can tell its two edits apart
// without a value leaving change-stream. The record's identifier is the caller's own test
// record.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { CHANGE_OPERATIONS } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const PROBE_STEPS = ['observe', 'resume', 'replay', 'forged_delivery'] as const;
export type ProbeStep = (typeof PROBE_STEPS)[number];

/** The digest of the named fields' values (pure): what change-stream reports and the caller compares with its own edits. */
export function probeDigest(values: Record<string, unknown>, fields: readonly string[]): string | null {
  if (!fields.some((f) => Object.hasOwn(values, f))) return null;
  const picked = Object.fromEntries([...fields].sort().map((f) => [f, values[f] ?? null]));
  return createHash('sha256').update(canonicalJsonBytes(picked)).digest('hex').slice(0, 32);
}

export const probeObservation = z.object({
  operation: z.enum(CHANGE_OPERATIONS),
  sourceSeq: z.string().max(200).nullable(),
  /** SHA-256 (hex, 32 characters) of the canonical JSON of the named fields' values; null where none was carried. */
  digest: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  duplicate: z.boolean(),
});
export type ProbeObservation = z.infer<typeof probeObservation>;

export const openStreamProbe = defineContract({
  service: 'change-stream', name: 'openStreamProbe', method: 'POST', path: '/v1/connections/:connectionId/stream/probes',
  callers: ['conformance'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  body: z.strictObject({ object: name }),
  response: z.object({
    probeId: z.uuid(),
    /** The source tested: what the stream uses now. */
    source: z.enum(['webhook', 'poll', 'cdc', 'none']),
    /** A poll source is declared: a read can resume from a watermark. */
    resumable: z.boolean(),
    ordering: z.enum(['source_sequence', 'observed_at']),
  }),
  status: 201,
  maxBodyBytes: 1_024,
});

export const readStreamProbe = defineContract({
  service: 'change-stream', name: 'readStreamProbe', method: 'POST', path: '/v1/stream-probes/:probeId/reads',
  callers: ['conformance'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ probeId: z.uuid() }),
  body: z.strictObject({
    /** The test record's identifier, as the manifest's identifier fields give it. */
    entityRef: z.string().min(1).max(512),
    fields: z.array(name).min(1).max(50),
    step: z.enum(PROBE_STEPS),
  }),
  response: z.object({
    observations: z.array(probeObservation).max(200),
    /** forged_delivery: the delivery was refused. */
    rejected: z.boolean().optional(),
  }),
  maxBodyBytes: 4_096,
});
