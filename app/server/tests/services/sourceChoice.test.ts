// Choosing a source (spec 69.6; decision 2026-11-14): coverage first; current state live by
// default; the Object Index for lookup, search and filtering when fresh; the Warehouse for
// history, as-of, aggregation over large sets and Silo-only properties; stale gives way to
// live; ties go to the fresher, then the cheaper; what is passed over is said.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chooseSource, type SourceCandidate, type SourceNeed } from '../../src/services/planner/sourceChoice.service.ts';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const live: SourceCandidate = { kind: 'live', holds: new Set(['name', 'status', 'amount']), history: null, watermark: null, estimatedCost: 100 };
const index: SourceCandidate = { kind: 'index', holds: new Set(['name', 'status']), history: null, watermark: minutesAgo(5), estimatedCost: 5 };
const warehouse: SourceCandidate = {
  kind: 'warehouse', holds: new Set(['name', 'status', 'amount', 'silo_only']), history: { from: '2025-01-01T00:00:00Z', to: null }, watermark: minutesAgo(30),
  estimatedCost: 20,
};
const need = (n: Partial<SourceNeed>): SourceNeed => ({ shape: 'filter', properties: ['name'], timeRange: null, asOf: null, largeSet: false, ...n });

describe('source choice (69.6)', () => {
  test('filtering on indexed properties goes to a fresh Index; a property it lacks sends it live, saying so', () => {
    assert.equal(chooseSource(need({ properties: ['name', 'status'] }), [live, index, warehouse], NOW).kind, 'index');
    const wider = chooseSource(need({ properties: ['name', 'amount'] }), [live, index, warehouse], NOW);
    assert.equal(wider.kind, 'live');
    assert.deepEqual(wider.passedOver.find((p) => p.kind === 'index'), { kind: 'index', missing: ['amount'], reason: 'coverage' });
  });

  test('an Index staler than the tolerance gives way to live pushdown', () => {
    const stale = { ...index, watermark: minutesAgo(20) };
    const choice = chooseSource(need({ properties: ['name'] }), [live, stale], NOW);
    assert.equal(choice.kind, 'live');
    assert.equal(choice.passedOver[0]?.reason, 'stale');
    assert.equal(chooseSource(need({ properties: ['name'], toleranceSeconds: 3600 }), [live, stale], NOW).kind, 'index', 'a request may tolerate more');
  });

  test('history, as-of and aggregation over a large set go to the Warehouse; a range it does not hold is refused', () => {
    assert.equal(chooseSource(need({ timeRange: { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' } }), [live, index, warehouse], NOW).kind, 'warehouse');
    assert.equal(chooseSource(need({ asOf: '2026-03-01T00:00:00Z' }), [live, warehouse], NOW).kind, 'warehouse');
    const fresh = { ...warehouse, watermark: minutesAgo(5) };
    assert.equal(chooseSource(need({ shape: 'aggregate', largeSet: true, properties: ['amount'] }), [live, fresh], NOW).kind, 'warehouse');
    assert.equal(chooseSource(need({ shape: 'aggregate', largeSet: true, properties: ['amount'] }), [live, warehouse], NOW).kind, 'live',
      'a Warehouse staler than the tolerance gives way to live for current state');
    assert.equal(chooseSource(need({ shape: 'aggregate', largeSet: false, properties: ['amount'] }), [live, warehouse], NOW).kind, 'live',
      'a small aggregate is pushed down live');
    const before = chooseSource(need({ asOf: '2024-06-01T00:00:00Z' }), [live, warehouse], NOW);
    assert.equal(before.kind, null, 'before the Warehouse\'s history begins');
    assert.equal(before.passedOver.find((p) => p.kind === 'warehouse')?.reason, 'time_range');
  });

  test('a property only a Silo holds goes to the Warehouse; history is not held to the current-state tolerance', () => {
    const only = chooseSource(need({ properties: ['silo_only'] }), [live, index, warehouse], NOW);
    assert.deepEqual([only.kind, 'stale' in only && only.stale], ['warehouse', true], 'nothing live holds it: the Warehouse, stated as of its watermark');
    assert.equal(chooseSource(need({ properties: ['silo_only'] }), [live, { ...warehouse, watermark: minutesAgo(5) }], NOW).kind, 'warehouse');
    const old = { ...warehouse, watermark: minutesAgo(600) };
    assert.equal(chooseSource(need({ timeRange: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' } }), [live, old], NOW).kind, 'warehouse');
  });

  test('ties: the fresher, then the cheaper', () => {
    const fresher = { ...index, watermark: minutesAgo(1), estimatedCost: 50 };
    const cheaper = { ...index, watermark: minutesAgo(10), estimatedCost: 1 };
    assert.equal(chooseSource(need({}), [cheaper, fresher], NOW).kind, 'index');
    const sameAge = [{ ...index, estimatedCost: 9 }, { ...index, estimatedCost: 3 }];
    assert.equal(chooseSource(need({}), sameAge, NOW).kind, 'index');
  });
});
