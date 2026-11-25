// The history detectors (spec 38.2, 67.1): timing deviation, drift and recurrence over the
// transitions Capture holds. Arithmetic: the modified z-score against a population (or the
// object's own past), the threshold derived from the sample, a fact never a judgement, and
// no record value in a finding (not even the state an object lingered in).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deriveHistoryThreshold, drift, modifiedZ, recurrence, timingDeviation, type Transition } from '../../src/services/recognition/history.service.ts';

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();
const t = (objectRef: string, previousValue: unknown, newValue: unknown, at: number): Transition => ({ objectRef, previousValue, newValue, observedAt: day(at) });
const fixed = (n: number) => () => n;

describe('history detectors (spec 38.2)', () => {
  test('the modified z-score, with the mean absolute deviation when the MAD is zero, and nothing where there is no spread', () => {
    assert.equal(Number(modifiedZ(10, [1, 2, 3, 4, 5])!.toFixed(4)), 4.7215);
    assert.ok(modifiedZ(5, [1, 1, 1, 1, 5])! > 0, 'MAD 0: falls back to the mean absolute deviation');
    assert.equal(modifiedZ(1, [1, 1, 1]), undefined);
    assert.deepEqual([deriveHistoryThreshold(29), deriveHistoryThreshold(30)], [5, 3.5]);
  });

  test('timing deviation: a stay, finished or still running, unusually long against every stay in that state', () => {
    const transitions: Transition[] = [];
    // Twelve orders each stay two or three days in 'open', then ship.
    for (let i = 0; i < 12; i += 1) transitions.push(t(`o${i}`, null, 'open', 0), t(`o${i}`, 'open', 'shipped', 2 + (i % 2)));
    // One took twenty days; one is still open after thirty.
    transitions.push(t('slow', null, 'open', 0), t('slow', 'open', 'shipped', 20), t('stuck', null, 'open', 0));
    const out = timingDeviation(transitions, 'status', new Date(day(30)), fixed(3.5));
    const raised = new Map(out.findings.map((f) => [f.objectIds[0], f]));
    assert.deepEqual([...raised.keys()].sort(), ['slow', 'stuck']);
    assert.equal(raised.get('stuck')!.statistic, 'running_stay_modified_z');
    assert.equal(raised.get('slow')!.statistic, 'stay_modified_z');
    assert.ok(!JSON.stringify(out.findings).includes('open'), 'the state is a record value: never in a finding');
    assert.ok(out.findings.every((f) => f.sampleSize === 13 && f.properties[0] === 'status'));
  });

  test('timing deviation judges no state with fewer than five finished stays', () => {
    const out = timingDeviation([t('a', null, 'x', 0), t('a', 'x', 'y', 50)], 'status', new Date(day(60)), fixed(3.5));
    assert.deepEqual([out.findings.length, out.detail['thinStates']], [0, 2]);
  });

  test("drift: the latest values moved one way, their median far from the object's own past", () => {
    const series = (ref: string, values: number[]) => values.map((v, i) => t(ref, i === 0 ? null : values[i - 1], v, i));
    const transitions = [...series('pump-1', [50, 51, 49, 50, 52, 50, 61, 66, 72]), ...series('pump-2', [50, 51, 49, 50, 52, 50, 49, 51, 50]),
      ...series('pump-3', [50, 51, 49, 50, 52, 50, 70, 60, 75])];
    const out = drift(transitions, 'pressure', fixed(3.5));
    assert.deepEqual(out.findings.map((f) => [f.objectIds[0], f.statistic]), [['pump-1', 'drift_up_modified_z']], 'pump-3 jumped about, it did not drift');
    assert.equal(out.findings[0]!.sampleSize, 6);
    assert.deepEqual(drift([t('x', null, 'high', 0)], 'pressure', fixed(3.5)).detail, { notNumeric: 1 });
  });

  test('recurrence: an object returning to states it held, far more often than the population', () => {
    const transitions: Transition[] = [];
    for (let i = 0; i < 10; i += 1) transitions.push(t(`c${i}`, 'new', 'active', 0), t(`c${i}`, 'active', 'closed', 1));
    let at = 0;
    for (const [from, to] of [['new', 'active'], ['active', 'held'], ['held', 'active'], ['active', 'held'], ['held', 'active'], ['active', 'held']]) {
      transitions.push(t('flapping', from, to, at += 1));
    }
    const out = recurrence(transitions, 'status', fixed(3.5));
    assert.deepEqual(out.findings.map((f) => [f.objectIds[0], f.statistic, f.sampleSize]), [['flapping', 'recurrences_modified_z', 11]]);
    assert.equal(recurrence(transitions.slice(0, 4), 'status', fixed(3.5)).findings.length, 0, 'under five objects, nothing is judged');
  });
});
