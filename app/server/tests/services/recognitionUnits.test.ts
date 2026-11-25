// The detectors' arithmetic and threshold tuning (spec 38.2, 38.4, 38.5), on their own.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deriveThreshold, runDetector, tunedThreshold, type PopulationObject } from '../../src/services/recognition/detectors.service.ts';

const obj = (id: string, values: Record<string, unknown>, extra: Partial<PopulationObject> = {}): PopulationObject =>
  ({ id, values, disputed: [], unmatched: false, ...extra });

describe('detectors (spec 38.2, 38.4)', () => {
  test('outlier: the modified z-score past its threshold; no spread, no finding; not numeric, counted', () => {
    const population = [10, 11, 12, 10, 11, 12, 10, 11, 12, 95].map((n, i) => obj(`o${i}`, { r: n, t: 'x' }));
    const out = runDetector('outlier', population, [{ apiName: 'r', dataType: 'integer' }, { apiName: 't', dataType: 'string' }], () => 5);
    assert.deepEqual(out.findings.map((f) => f.objectIds), [['o9']]);
    assert.equal(out.findings[0]!.statistic, 'robust_z');
    assert.equal(out.detail['notNumeric'], 1);
    const flat = runDetector('outlier', [1, 1, 1, 1].map((n, i) => obj(`f${i}`, { r: n })), [{ apiName: 'r', dataType: 'integer' }], () => 3.5);
    assert.deepEqual(flat.findings, []);
    assert.equal(flat.detail['noSpread'], 1);
  });

  test('a disputed value is never examined as if decided', () => {
    const population = [10, 11, 12, 10, 11, 12, 10, 11, 12].map((n, i) => obj(`o${i}`, { r: n }));
    population.push(obj('d', { r: 95 }, { disputed: ['r'] }));
    assert.deepEqual(runDetector('outlier', population, [{ apiName: 'r', dataType: 'integer' }], () => 5).findings, []);
    const dup = runDetector('duplicate_value', [obj('a', { e: 'x' }, { disputed: ['e'] }), obj('b', { e: 'x' })], [{ apiName: 'e', dataType: 'string' }], () => 2);
    assert.deepEqual(dup.findings, []);
  });

  test('missing_value: a gap where the property is otherwise filled at least to the threshold', () => {
    const population = Array.from({ length: 10 }, (_, i) => obj(`o${i}`, { e: i === 3 ? null : 'v' }));
    const out = runDetector('missing_value', population, [{ apiName: 'e', dataType: 'string' }], () => 0.85);
    assert.deepEqual(out.findings.map((f) => [f.objectIds, f.value]), [[['o3'], 0.9]]);
    assert.deepEqual(runDetector('missing_value', population, [{ apiName: 'e', dataType: 'string' }], () => 0.95).findings, []);
  });

  test('duplicate_value names the objects that share a value, never the value', () => {
    const out = runDetector('duplicate_value', [obj('a', { e: 'same' }), obj('b', { e: 'same' }), obj('c', { e: 'other' })], [{ apiName: 'e', dataType: 'string' }], () => 2);
    assert.equal(out.findings.length, 1);
    assert.deepEqual(out.findings[0]!.objectIds, ['a', 'b']);
    assert.ok(!JSON.stringify(out.findings).includes('same'));
  });

  test('disagreement and unmatched_record', () => {
    const population = [obj('a', {}, { disputed: ['n', 'm'] }), obj('b', {}, { disputed: ['n'] }), obj('c', {}, { unmatched: true })];
    const props = [{ apiName: 'n', dataType: 'string' }, { apiName: 'm', dataType: 'string' }];
    assert.deepEqual(runDetector('disagreement', population, props, () => 1).findings.map((f) => f.objectIds[0]), ['a', 'b']);
    assert.deepEqual(runDetector('disagreement', population, props, () => 1.25).findings.map((f) => f.objectIds[0]), ['a']);
    assert.deepEqual(runDetector('unmatched_record', population, [], () => 1).findings.map((f) => f.objectIds[0]), ['c']);
  });

  test('uniqueness: objects agreeing on every property named, never on one alone (decision 2026-11-14)', () => {
    const props = [{ apiName: 'name', dataType: 'string' }, { apiName: 'postcode', dataType: 'string' }];
    const population = [
      obj('a', { name: 'Acme Ltd', postcode: 'SW1A 1AA' }), obj('b', { name: ' acme ltd', postcode: 'sw1a 1aa' }),
      obj('c', { name: 'Acme Ltd', postcode: 'EC1A 1BB' }), obj('d', { name: 'Acme Ltd', postcode: null }),
    ];
    const out = runDetector('uniqueness', population, props, () => 2);
    assert.deepEqual(out.findings.map((f) => [f.objectIds, f.statistic, f.value]), [[['a', 'b'], 'duplicate_entities', 2]]);
    assert.ok(!JSON.stringify(out.findings).toLowerCase().includes('acme'));
    assert.deepEqual(runDetector('uniqueness', population, props.slice(0, 1), () => 2).detail, { tooFewProperties: 1 });
  });

  test('timeliness: an object updated far longer ago than its population; never a value (decision 2026-11-14)', () => {
    const day = 86_400_000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
    const population = [...[1, 2, 2, 3, 3, 4, 5].map((d, i) => obj(`o${i}`, { updated: at(d) })), obj('stale', { updated: at(120) }), obj('bad', { updated: 'never' })];
    const out = runDetector('timeliness', population, [{ apiName: 'updated', dataType: 'timestamp' }], () => deriveThreshold('timeliness', population.length));
    assert.deepEqual(out.findings.map((f) => [f.objectIds[0], f.statistic]), [['stale', 'age_robust_z']]);
    assert.equal(out.detail['notATime'], 1);
    assert.equal(deriveThreshold('timeliness', 40), 3.5);
  });

  test('the same inputs and threshold give the same findings, in the same order', () => {
    const population = Array.from({ length: 40 }, (_, i) => obj(`o${String(i).padStart(2, '0')}`, { r: i % 7 === 0 ? 500 + i : 10 + (i % 3) }));
    const once = runDetector('outlier', population, [{ apiName: 'r', dataType: 'integer' }], () => deriveThreshold('outlier', 40));
    const twice = runDetector('outlier', [...population].reverse(), [{ apiName: 'r', dataType: 'integer' }], () => deriveThreshold('outlier', 40));
    assert.deepEqual(once, twice);
    assert.ok(once.findings.length > 0);
  });

  test('thresholds derive from the population, deterministically', () => {
    assert.equal(deriveThreshold('outlier', 12), 5);
    assert.equal(deriveThreshold('outlier', 30), 3.5);
    assert.equal(deriveThreshold('missing_value', 12), 0.5);
    assert.equal(deriveThreshold('missing_value', 10_000), 0.97);
    assert.equal(deriveThreshold('duplicate_value', 1), 2);
  });
});

describe('tuning (spec 38.5)', () => {
  test('nothing under five dispositions; the majority moves it; at most a quarter; deferrals count to the floor only', () => {
    assert.equal(tunedThreshold(4, { confirmed: 0, dismissed: 4, deferred: 0 }), undefined);
    assert.equal(tunedThreshold(4, { confirmed: 0, dismissed: 5, deferred: 0 }), 4.7143, 'all five dismissed: up, by less than the quarter cap on five');
    assert.equal(tunedThreshold(4, { confirmed: 5, dismissed: 0, deferred: 0 }), 3.2857, 'all five confirmed: down likewise');
    assert.equal(tunedThreshold(4, { confirmed: 1, dismissed: 4, deferred: 0 }), 4.4286, 'a slimmer majority, a smaller step');
    assert.equal(tunedThreshold(4, { confirmed: 2, dismissed: 3, deferred: 0 }), undefined, 'three in five is not 80% sure of a majority');
    assert.ok(tunedThreshold(4, { confirmed: 0, dismissed: 200, deferred: 0 })! <= 5, 'never more than a quarter');
    assert.equal(tunedThreshold(4, { confirmed: 2, dismissed: 2, deferred: 1 }), undefined, 'no majority');
    assert.equal(tunedThreshold(4, { confirmed: 0, dismissed: 2, deferred: 3 }), undefined, 'deferrals are no direction');
    assert.equal(tunedThreshold(0.9, { confirmed: 0, dismissed: 5, deferred: 0 }, 1), 1, 'a fill rate never passes 1');
  });
});
