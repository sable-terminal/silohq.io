// The change-stream class (contracts/conformance/changeStreamClass.contract.ts; spec 17.2;
// decision 2026-11-15): one streamed object, one test record.
//
// change-stream opens a probe on the object, so the stream is watched as it is used. Then,
// through connect-runtime's sandboxed write path: the test record is created; edited (a
// delta must arrive); edited again; its changes are replayed (each must be discarded as a
// repeat) and read again from the watermark held before the edits (its latest state must be
// there); it is deleted (a delete must arrive); and, for a webhook, a delivery not signed
// with the connection's secret is offered (it must be refused). The order in which the two
// edits and the delete arrived is judged last, over everything that arrived. Each wait is
// bounded; a change that does not arrive in time fails its test. Values stay in the write
// calls: what comes back from change-stream is operations, sequences and digests.

import { openStreamProbe, probeDigest, readStreamProbe, type ProbeObservation, type ProbeStep } from '../../contracts/change-stream/probe.contract.ts';
import { writeRecords, type WriteResult } from '../../contracts/connect-runtime/write.contract.ts';
import { STREAM_TESTS, streamTestId, type StreamTest } from '../../contracts/conformance/changeStreamClass.contract.ts';
import type { ConformanceTest } from '../../contracts/conformance/conformance.contract.ts';
import type { ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export interface StreamClassInput {
  object: string;
  create: Record<string, unknown>;
  updates: [Record<string, unknown>, Record<string, unknown>];
}

export interface StreamClassTiming {
  /** How long a change may take to arrive after an edit. */
  waitMs: number;
  /** How often to look meanwhile. */
  pollMs: number;
}

/** Watermarks and sequences order as numbers when both are numbers, else as text (pure). */
function after(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) ? x > y : a > b;
}

function lastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return i;
  return -1;
}

/**
 * Whether what arrived (fresh changes, in arrival order) came in the order made: the first
 * edit before the second, nothing of the first after the second, the delete after both; and,
 * where the manifest orders by source sequence, every sequence present and none going back (pure).
 */
export function orderedVerdict(observations: readonly ProbeObservation[], digests: readonly (string | null)[],
  ordering: 'source_sequence' | 'observed_at', deleteExpected: boolean): { passed: boolean; reason: string | null } {
  const first = observations.findIndex((o) => o.digest === digests[0]);
  const second = observations.findIndex((o) => o.digest === digests[1]);
  if (first < 0) return { passed: false, reason: 'first_edit_missing' };
  if (second < 0) return { passed: false, reason: 'second_edit_missing' };
  if (second < first || lastIndex(observations, (o) => o.digest === digests[0]) > second) return { passed: false, reason: 'edits_out_of_order' };
  if (deleteExpected) {
    const deleted = observations.findIndex((o) => o.operation === 'delete');
    if (deleted >= 0 && deleted < lastIndex(observations, (o) => o.digest === digests[1])) return { passed: false, reason: 'delete_out_of_order' };
  }
  if (ordering === 'source_sequence') {
    const sequences = observations.map((o) => o.sourceSeq);
    if (sequences.some((s) => s === null)) return { passed: false, reason: 'sequence_missing' };
    for (let i = 1; i < sequences.length; i += 1) {
      if (after(sequences[i - 1]!, sequences[i]!)) return { passed: false, reason: 'sequence_out_of_order' };
    }
  }
  return { passed: true, reason: null };
}

/** Runs the class; the tests in the contract's order, and the test record's identifier where one was created. */
export async function runStreamClass(services: ServiceClient, options: { request: RequestContext; correlationId: string; signal: AbortSignal },
  connectionId: string, object: ManifestObject, input: StreamClassInput, timing: StreamClassTiming): Promise<{ tests: ConformanceTest[]; testRecordRef: string | null }> {
  const tests: ConformanceTest[] = [];
  const record = (test: StreamTest, outcome: ConformanceTest['outcome'], reason: string | null, since: number) => tests.push({
    id: streamTestId(test, object.name), class: 'change_stream', object: object.name, outcome,
    durationMs: Math.max(0, Math.round(performance.now() - since)), reason: reason === null ? null : reason.slice(0, 200), operator: null,
  });
  const ordered = () => tests.sort((a, b) => STREAM_TESTS.indexOf(a.id.split('.')[1] as StreamTest) - STREAM_TESTS.indexOf(b.id.split('.')[1] as StreamTest));
  const all = (outcome: ConformanceTest['outcome'], reason: string, testRecordRef: string | null = null) => {
    const now = performance.now();
    for (const test of STREAM_TESTS) if (!tests.some((t) => t.id === streamTestId(test, object.name))) record(test, outcome, reason, now);
    return { tests: ordered(), testRecordRef };
  };

  if (object.writes?.create === undefined || object.writes.update === undefined || object.writes.delete === undefined) {
    return all('not_applicable', 'create_update_delete_undeclared');
  }
  const call = { request: options.request, correlationId: options.correlationId, signal: options.signal };
  const probe = await services.call(openStreamProbe, { params: { connectionId }, body: { object: object.name } }, call);
  if (probe.source === 'cdc') return all('not_applicable', 'cdc_runs_in_agent');
  if (probe.source === 'none') return all('not_applicable', 'no_source_enabled');

  const write = async (op: { operation: 'create' | 'update_partial' | 'delete'; identifier?: string; values?: Record<string, unknown> }): Promise<WriteResult> => {
    const out = await services.call(writeRecords, {
      body: { connectionId, object: object.name, sandbox: true, operations: [{ key: uuidv7(), ...op, values: (op.values ?? {}) as never }] },
    }, call);
    return out.results[0]!;
  };
  const failure = (step: string, result: WriteResult) => `${step}_${result.error?.code ?? 'failed'}`;
  const fields = Object.keys(input.updates[0]).sort();
  const digests = input.updates.map((u) => probeDigest(u, fields));
  let entityRef = '';
  const read = (step: ProbeStep) => services.call(readStreamProbe, { params: { probeId: probe.probeId }, body: { entityRef, fields, step } }, call);
  const fresh = (observations: readonly ProbeObservation[]) => observations.filter((o) => !o.duplicate);
  /** Looks until what arrived satisfies the predicate, or the wait ends. */
  async function until(predicate: (observations: ProbeObservation[]) => boolean): Promise<ProbeObservation[] | undefined> {
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
      const seen = fresh((await read('observe')).observations);
      if (predicate(seen)) return seen;
      if (Date.now() >= deadline || options.signal.aborted) return undefined;
      await sleep(timing.pollMs, options.signal).catch(() => undefined);
    }
  }

  const created = await write({ operation: 'create', values: input.create });
  if (created.outcome !== 'applied' || created.identifier === null) return all('failed', failure('create', created));
  entityRef = created.identifier;
  // From here the probe watches the test record.
  await read('observe');

  let since = performance.now();
  const first = await write({ operation: 'update_partial', identifier: entityRef, values: input.updates[0] });
  const seen = first.outcome === 'applied' ? await until((o) => o.some((x) => x.digest === digests[0])) : undefined;
  record('delta', seen ? 'passed' : 'failed', first.outcome !== 'applied' ? failure('update', first) : seen ? null : 'no_delta_within_wait', since);

  const orderedSince = performance.now();
  const second = await write({ operation: 'update_partial', identifier: entityRef, values: input.updates[1] });
  const secondSeen = second.outcome === 'applied' ? await until((o) => o.some((x) => x.digest === digests[1])) : undefined;

  since = performance.now();
  const replayed = (await read('replay')).observations;
  const repeated = replayed.length > 0 && replayed.every((o) => o.duplicate);
  record('deduplicated', repeated ? 'passed' : 'failed', repeated ? null : replayed.length === 0 ? 'nothing_replayed' : 'replay_accepted', since);

  since = performance.now();
  if (!probe.resumable) {
    record('resumable', 'failed', 'no_resume_source', since);
  } else {
    const resumed = (await read('resume')).observations;
    const latest = digests[secondSeen ? 1 : 0];
    record('resumable', resumed.some((o) => o.digest === latest) ? 'passed' : 'failed', resumed.some((o) => o.digest === latest) ? null : 'resume_missed_change', since);
  }

  since = performance.now();
  const deleted = await write({ operation: 'delete', identifier: entityRef });
  const gone = deleted.outcome === 'applied' ? await until((o) => o.some((x) => x.operation === 'delete')) : undefined;
  record('deletes', gone ? 'passed' : 'failed', deleted.outcome !== 'applied' ? failure('delete', deleted) : gone ? null : 'delete_not_signalled', since);

  const arrived = gone ?? fresh((await read('observe')).observations);
  const verdict = second.outcome !== 'applied' ? { passed: false, reason: failure('update', second) }
    : orderedVerdict(arrived, digests, probe.ordering, gone !== undefined);
  record('ordered', verdict.passed ? 'passed' : 'failed', verdict.reason, orderedSince);

  since = performance.now();
  if (probe.source !== 'webhook') {
    record('signature', 'not_applicable', 'not_a_signed_source', since);
  } else {
    const { rejected } = await read('forged_delivery');
    record('signature', rejected === true ? 'passed' : 'failed', rejected === true ? null : 'forged_delivery_accepted', since);
  }
  return { tests: ordered(), testRecordRef: entityRef };
}
