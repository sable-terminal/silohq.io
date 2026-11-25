// Process mining (D234): traces, the directly-follows graph with timings, variants, durations,
// rework, conformance against a reference model, and events from captured changes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventsFromTransitions, mine, quantile } from '../../src/services/workspace/processMining.service.ts';

const h = 3_600_000;
const log = [
  // Three orders: two straight through, one with a rework loop.
  { case: 'o1', activity: 'received', at: 0 }, { case: 'o1', activity: 'approved', at: 1 * h }, { case: 'o1', activity: 'shipped', at: 3 * h },
  { case: 'o2', activity: 'received', at: 0 }, { case: 'o2', activity: 'approved', at: 2 * h }, { case: 'o2', activity: 'shipped', at: 5 * h },
  { case: 'o3', activity: 'received', at: 0 }, { case: 'o3', activity: 'approved', at: 1 * h }, { case: 'o3', activity: 'received', at: 2 * h },
  { case: 'o3', activity: 'approved', at: 4 * h }, { case: 'o3', activity: 'shipped', at: 9 * h },
];

test('quantiles by nearest rank', () => {
  assert.deepEqual([quantile([1, 2, 3, 4], 0.5), quantile([1, 2, 3, 4], 0.9), quantile([], 0.5)], [2, 4, null]);
});

test('activities, the directly-follows graph with timings, variants, durations and rework', () => {
  const m = mine(log);
  assert.deepEqual([m.events, m.cases], [11, 3]);
  assert.deepEqual(m.activities.map((a) => [a.name, a.events, a.cases, a.starts, a.ends]), [
    ['approved', 4, 3, 0, 0], ['received', 4, 3, 3, 0], ['shipped', 3, 3, 0, 3],
  ]);
  const edge = (from: string, to: string) => m.edges.find((e) => e.from === from && e.to === to)!;
  assert.deepEqual([edge('received', 'approved').count, edge('received', 'approved').cases, edge('received', 'approved').medianSeconds], [4, 3, 3600]);
  assert.deepEqual([edge('approved', 'received').count, edge('approved', 'shipped').p90Seconds], [1, 5 * 3600]);
  assert.deepEqual(m.variants.map((v) => [v.path.join('>'), v.cases]), [['received>approved>shipped', 2], ['received>approved>received>approved>shipped', 1]]);
  assert.equal(m.variants[0]!.share, 2 / 3);
  assert.deepEqual(m.caseDuration, { medianSeconds: 5 * 3600, p90Seconds: 9 * 3600, maxSeconds: 9 * 3600 });
  assert.deepEqual(m.rework, [{ activity: 'approved', cases: 1 }, { activity: 'received', cases: 1 }]);
  assert.equal(m.conformance, null);
});

test('conformance against a reference model: which cases fit, which steps deviate, where cases start or end wrongly', () => {
  const m = mine(log, { transitions: [['received', 'approved'], ['approved', 'shipped']], starts: ['received'], ends: ['shipped'] });
  assert.deepEqual(m.conformance, { fitting: 2, deviating: 1, deviations: [{ from: 'approved', to: 'received', cases: 1 }], badStarts: [], badEnds: [] });
});

test('events from captured changes of a state property: each value entered, and where the case started', () => {
  const events = eventsFromTransitions([
    { objectRef: 'a', previousValue: 'open', newValue: 'review', observedAt: '2026-11-01T10:00:00Z' },
    { objectRef: 'a', previousValue: 'review', newValue: 'closed', observedAt: '2026-11-02T10:00:00Z' },
  ]);
  assert.deepEqual(events.map((e) => e.activity), ['open', 'review', 'closed']);
  assert.deepEqual(mine(events).variants[0]!.path, ['open', 'review', 'closed']);
});
