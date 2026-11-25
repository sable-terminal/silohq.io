// The release gates as pure functions over a cell's signals (spec 11.2): a missing signal fails,
// a little traffic is not judged on latency or refusals, refusals are judged against the release
// before, or a quarter with none to compare.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProcessSignals } from '../../src/contracts/fleet-control/signals.contract.ts';
import { createSignalStore, judgeGates, p95 } from '../../src/services/fleet-control/cellSignals.service.ts';

const at = '2026-11-18T12:00:00.000Z';
const signals = (release: string, total: number, refused = 0, errors = 0, latency: number[] = [total, 0, 0, 0, 0, 0, 0, 0, 0]): ProcessSignals => ({
  services: ['actions'], release, startedAt: at, reportedAt: at, requests: { total, refused, errors, latency }, gauges: {},
});
const pod = (release: string, restartCount = 0) => ({ metadata: { name: 'p', annotations: { 'silo.io/release': release } }, status: { containerStatuses: [{ restartCount }] } });
const failed = (gates: { gate: string; passed: boolean }[]) => gates.filter((g) => !g.passed).map((g) => g.gate).sort();

describe('release gates (spec 11.2)', () => {
  test('a missing signal is a failure: no process on the release, no pod of it, no relay reporting', () => {
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [], previous: [], outboxOldest: [], pods: [pod('r1')] })),
      ['audit_outbox_backlog', 'crash_loops', 'error_rate', 'latency', 'refusal_rate']);
  });

  test('little traffic is not judged on latency or refusals; idle processes pass', () => {
    assert.equal(p95([signals('r2', 19, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0, 19])]), undefined);
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [signals('r2', 19, 10, 0, [0, 0, 0, 0, 0, 0, 0, 0, 19])], previous: [], outboxOldest: [0], pods: [pod('r2')] })), []);
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [signals('r2', 0)], previous: [], outboxOldest: [0], pods: [pod('r2')] })), []);
  });

  test('refusals against the release before, or a quarter with none to compare; restarts and the 95th percentile', () => {
    const before = [signals('r1', 1_000, 100)];
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [signals('r2', 100, 20)], previous: before, outboxOldest: [1], pods: [pod('r2')] })), [], '20% is twice 10%');
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [signals('r2', 100, 21)], previous: before, outboxOldest: [1], pods: [pod('r2')] })), ['refusal_rate']);
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [signals('r2', 100, 25)], previous: [], outboxOldest: [1], pods: [pod('r2')] })), []);
    assert.deepEqual(failed(judgeGates({ releaseId: 'r2', current: [signals('r2', 100, 26)], previous: [], outboxOldest: [1], pods: [pod('r2', 3)] })), ['crash_loops', 'refusal_rate']);
    assert.equal(p95([signals('r2', 100, 0, 0, [90, 4, 0, 0, 0, 6, 0, 0, 0])]), 2_500);
  });

  test('the store keeps each process\'s latest report and refuses an older one', () => {
    let now = Date.parse(at);
    const store = createSignalStore(() => now);
    assert.equal(store.receive('a', { ...signals('r1', 5), reportedAt: '2026-11-18T12:00:10.000Z' }), true);
    assert.equal(store.receive('a', { ...signals('r1', 3), reportedAt: '2026-11-18T12:00:05.000Z' }), false);
    assert.equal(store.on('r1')[0]!.requests.total, 5);
    now += 180_000;
    assert.deepEqual(store.on('r1', 120_000), [], 'a stale report does not count as fresh');
    assert.equal(store.on('r1').length, 1, 'but is kept for the release after to compare with');
  });
});
