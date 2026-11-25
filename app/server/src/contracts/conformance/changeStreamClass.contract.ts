// The change-stream class (spec 17.2; decision 2026-11-15): what makes a stream subscribable.
//
// A stream is subscribable when it passes change-stream conformance: its events are ordered,
// deduplicated, resumable from a sequence or watermark, and signal deletes. The class runs
// per streamed object, on a test record Silo creates, edits twice and deletes through
// connect-runtime's sandboxed write path, while change-stream watches the object through a
// probe (contracts/change-stream/probe.contract.ts). Each test is passed, failed, or not
// applicable (never counted as passed):
//   delta         an edit to the test record produced a delta;
//   ordered       the two edits, then the delete, arrived in the order made (and in source
//                 sequence where the manifest orders by it);
//   deduplicated  a replayed delivery was discarded as a repeat;
//   resumable     a read from the watermark held before the edits brought the record's latest
//                 state (a webhook alone cannot resume: it needs a poll source beside it);
//   deletes       deleting the test record produced a delete;
//   signature     a delivery not signed with the connection's secret was refused (a webhook
//                 source; not applicable to polling).
// The run is recorded in connect.conformance_runs with class change_stream; results hold test
// ids, outcomes and reason codes, never values. The test record's identifier is kept as the
// run's test_record_ref, as the write class keeps it.
//
// The gate: an object is subscribable on the connection's current manifest version when the
// latest completed change_stream run that tested it passed delta, ordered, deduplicated,
// resumable and deletes, and failed nothing. What it gates (decision 2026-11-15): live viewer
// subscriptions (and with them the Clone Canvas's live state) and Crons with change
// conditions. On-demand queries and scheduled Crons need no stream.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { conformanceResults, conformanceRunView } from './conformance.contract.ts';

export const STREAM_TESTS = ['delta', 'ordered', 'deduplicated', 'resumable', 'deletes', 'signature'] as const;
export type StreamTest = (typeof STREAM_TESTS)[number];
/** Passed, each, for an object to be subscribable. */
export const REQUIRED_STREAM_TESTS: readonly StreamTest[] = ['delta', 'ordered', 'deduplicated', 'resumable', 'deletes'];

export const streamTestId = (test: StreamTest, object: string): string => `change_stream.${test}.${object}`;

export interface StreamGate {
  subscribable: boolean;
  /** The run read; null when none tested the object on this version. */
  runId: string | null;
  /** Required tests not passed, and any test failed, by name. */
  failed: StreamTest[];
}

/** Whether a run's record tested this object (pure). */
export function testsObject(run: { results: unknown }, object: string): boolean {
  const parsed = conformanceResults.safeParse(run.results);
  return parsed.success && parsed.data.some((t) => t.class === 'change_stream' && t.object === object);
}

/** The gate for one object over the latest run that tested it (pure). */
export function streamGateOf(run: { id: string; results: unknown; completedAt: string | null } | undefined, object: string): StreamGate {
  if (run === undefined || run.completedAt === null) return { subscribable: false, runId: run?.id ?? null, failed: [...REQUIRED_STREAM_TESTS] };
  const parsed = conformanceResults.safeParse(run.results);
  const tests = parsed.success ? parsed.data.filter((t) => t.class === 'change_stream' && t.object === object) : [];
  const outcome = (test: StreamTest) => tests.find((t) => t.id === streamTestId(test, object))?.outcome;
  const failed = STREAM_TESTS.filter((test) => outcome(test) === 'failed' || (REQUIRED_STREAM_TESTS.includes(test) && outcome(test) !== 'passed'));
  return { subscribable: failed.length === 0, runId: run.id, failed };
}

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const values = z.record(name, z.json());

export const startChangeStreamClass = defineContract({
  service: 'conformance', name: 'startChangeStreamClass', method: 'POST', path: '/v1/connections/:connectionId/change-stream-class',
  callers: ['gateway'],
  // The run waits on the source's deliveries, so it continues after the reply; read it back
  // with getConformanceRun. A retried request returns the first.
  context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ connectionId: z.uuid() }),
  body: z.strictObject({
    object: name,
    /** Values for the test record, created and later deleted. The requester's: no engine can invent values a source accepts. */
    create: values,
    /** Two edits of the same fields, made in turn: the second's values differ from the first's. */
    updates: z.tuple([values, values]),
  }).refine((b) => {
    const [first, second] = b.updates;
    const keys = (v: Record<string, unknown>) => Object.keys(v).sort().join(',');
    return Object.keys(first).length > 0 && keys(first) === keys(second) && JSON.stringify(first) !== JSON.stringify(second);
  }, 'two edits of the same fields, with different values'),
  response: conformanceRunView,
  status: 202,
  maxBodyBytes: 64 * 1024,
});
