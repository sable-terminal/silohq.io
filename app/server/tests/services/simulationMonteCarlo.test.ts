// Probabilistic propagation (spec 39.5): each iteration samples each observed edge from its
// own observations and walks the path by the deterministic rules; a path with a stated edge
// is computed deterministically; the draws are seeded, so a run can be reproduced.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { observed, pathOutcome, seeded, simulatePath, type PathEdge } from '../../src/services/simulation/montecarlo.service.ts';

const hour = 3_600;
const edge = (over: Partial<PathEdge>): PathEdge => ({ id: 'e', kind: 'soft', leadSeconds: 10 * hour, bufferSeconds: 0, samples: null, ...over });

describe('probabilistic propagation (spec 39.5)', () => {
  test('a path walked by the deterministic rules: a failure through hard and soft edges, a delay losing each buffer', () => {
    const lead = (e: PathEdge) => e.leadSeconds;
    assert.equal(pathOutcome([edge({ kind: 'hard' })], null, lead), null, 'a hard edge fails the next object');
    assert.equal(pathOutcome([edge({ bufferSeconds: 4 * hour })], null, lead), 6 * hour, 'a soft edge delays it by lead less buffer');
    assert.equal(pathOutcome([edge({ bufferSeconds: 2 * hour })], 5 * hour, lead), 3 * hour);
    assert.equal(pathOutcome([edge({}), edge({ bufferSeconds: 20 * hour })], null, lead), undefined, 'a buffer that absorbs the delay ends the path');
  });

  test('samples drawn from the observations: the probability of being affected, the median and the spread, reproducibly', () => {
    // Lead times of 2h to 8h observed; a 5h buffer downstream absorbs the shorter ones.
    const path = [edge({ samples: [2, 3, 4, 5, 6, 7, 8].map((h) => h * hour) }), edge({ bufferSeconds: 5 * hour, samples: [hour] })];
    const a = simulatePath(path, null, 2_000, seeded('run-1'));
    const b = simulatePath(path, null, 2_000, seeded('run-1'));
    assert.deepEqual(a, b, 'the same run draws the same numbers');
    assert.ok(a.probability > 0.35 && a.probability < 0.5, `about three in seven: ${a.probability}`);
    assert.ok(a.median! >= 1 * hour && a.median! <= 3 * hour && a.p10! <= a.median! && a.median! <= a.p90!);
    assert.equal(a.iterations, 2_000);
    assert.equal(simulatePath([edge({ kind: 'hard', samples: [hour] })], null, 100, seeded('x')).fails, true);
  });

  test('a path is observed only when every edge on it has observations', () => {
    assert.equal(observed([edge({ samples: [hour] }), edge({ samples: [hour] })]), true);
    assert.equal(observed([edge({ samples: [hour] }), edge({})]), false, 'a stated lead time is never widened into a range');
    assert.equal(observed([]), false);
  });
});
