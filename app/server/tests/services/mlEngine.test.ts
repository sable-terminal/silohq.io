// Machine learning models' arithmetic (D240), on data whose answer is known: an encoder that tells
// numbers from categories; ridge regression recovering a line; multinomial logistic regression
// separating three classes; the metrics of each; importance led by the feature that matters; a
// stable hold-out; drift that is near nothing for the training population and large for a shifted one.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classificationMetrics, drift, encode, fitClassification, fitEncoder, fitRegression, heldOut, importance, predictClass, predictValue, regressionMetrics,
  type Value,
} from '../../src/services/workspace/mlEngine.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';

/** A seeded uniform generator, so the data are the same every run. */
function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

describe('ML models: the arithmetic (D240)', () => {
  test('an encoder: a number standardised (gaps the mean), a category one-hot over its most frequent values and other', () => {
    const e = fitEncoder(['size', 'region'], [[1, 'north'], [3, 'south'], ['5', 'north'], [null, 'east'], [3, null]]);
    assert.equal(e.features[0]!.kind, 'number');
    assert.deepEqual(e.features[1]!.kind === 'category' ? e.features[1]!.values : [], ['north', 'east', 'south']);
    assert.equal(e.columns, 1 + 4);
    const x = encode(e, [null, 'west']);
    assert.deepEqual([...x], [0, 0, 0, 0, 1], 'a gap is the mean; an unseen category is other');
    assert.throws(() => fitEncoder(Array.from({ length: 41 }, (_, i) => `c${i}`), [Array.from({ length: 41 }, (_, i) => `v${i}`), Array.from({ length: 41 }, (_, i) => `w${i}`)].concat(
      Array.from({ length: 10 }, (_, r) => Array.from({ length: 41 }, (__, i) => `x${r}${i}`)))), /at most 400/);
  });

  test('ridge regression recovers a line and a category\'s effect; its metrics; importance led by what matters', () => {
    const rand = seeded(1);
    const rows: Value[][] = [];
    const ys: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = rand() * 10; const b = rand() * 10; const region = rand() < 0.5 ? 'north' : 'south';
      rows.push([a, b, region]);
      ys.push(3 * a - 0.5 * b + (region === 'north' ? 4 : 0) + 5 + (rand() - 0.5) * 0.1);
    }
    const encoder = fitEncoder(['a', 'b', 'region'], rows);
    const xs = rows.map((r) => encode(encoder, r));
    const model = fitRegression(xs, ys, 0.01);
    const predicted = xs.map((x) => predictValue(model, x));
    const metrics = regressionMetrics(ys, predicted);
    assert.ok(metrics.r2 > 0.999 && metrics.rmse < 0.1, JSON.stringify(metrics));
    assert.ok(Math.abs(predictValue(model, encode(encoder, [2, 4, 'north'])) - (6 - 2 + 4 + 5)) < 0.1);
    assert.equal(importance(encoder, model)[0]!.feature, 'a');
  });

  test('multinomial logistic regression separates three classes; accuracy, F1, log loss, confusion, precision and recall', () => {
    const rand = seeded(2);
    const rows: Value[][] = [];
    const ys: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const c = i % 3;
      rows.push([c * 4 + rand(), rand() * 3]);
      ys.push(c);
    }
    const classes = ['low', 'mid', 'high'];
    const encoder = fitEncoder(['x', 'noise'], rows);
    const xs = rows.map((r) => encode(encoder, r));
    const model = fitClassification(xs, ys, classes, { epochs: 30 });
    const probabilities = xs.map((x) => predictClass(model, x).probabilities);
    const m = classificationMetrics(classes, ys, probabilities);
    assert.ok(m.accuracy > 0.97 && m.macroF1 > 0.97, JSON.stringify({ accuracy: m.accuracy, f1: m.macroF1 }));
    assert.equal(m.confusion.flat().reduce((a, b) => a + b, 0), 1500);
    assert.equal(predictClass(model, encode(encoder, [8.5, 1])).label, 'high');
    assert.equal(importance(encoder, model)[0]!.feature, 'x');
    const again = fitClassification(xs, ys, classes, { epochs: 30 });
    assert.deepEqual(again.weights, model.weights, 'the same data fit the same model');
  });

  test('importance (D246): a strong number leads a category with many values that hardly matters, and a category is weighed as one feature', () => {
    const rand = seeded(5);
    const rows: Value[][] = [];
    const ys: number[] = [];
    for (let i = 0; i < 400; i++) {
      const total = 20 + ((i * 37) % 280);
      rows.push([total, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][i % 8]!]);
      ys.push(total + (rand() - 0.5) * 20 < 150 ? 0 : 1);
    }
    const encoder = fitEncoder(['total', 'customer'], rows);
    const model = fitClassification(rows.map((r) => encode(encoder, r)), ys, ['paid', 'open'], { epochs: 40 });
    const ranked = importance(encoder, model);
    assert.equal(ranked[0]!.feature, 'total', JSON.stringify(ranked));
    assert.ok(ranked[0]!.weight > 0.8, JSON.stringify(ranked));
    // A constant added to every value's weight moves no score between rows: the category's importance is unchanged.
    const shifted = { ...model, weights: model.weights.map((w) => w.map((v, j) => (j >= 1 ? v + 5 : v))) };
    const again = importance(encoder, shifted);
    assert.deepEqual(again.map((r) => r.feature), ranked.map((r) => r.feature));
    assert.ok(again.every((r, i) => Math.abs(r.weight - ranked[i]!.weight) < 1e-9), JSON.stringify(again));
  });

  test('a stable hold-out of about one in five; drift near nothing for the training population and large for a shifted one', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    const share = ids.filter(heldOut).length / ids.length;
    assert.ok(share > 0.17 && share < 0.23, String(share));
    assert.equal(heldOut(ids[0]!), heldOut(ids[0]!));
    const rand = seeded(3);
    const rows: Value[][] = Array.from({ length: 2000 }, () => [rand() * 100, rand() < 0.7 ? 'north' : 'south']);
    const encoder = fitEncoder(['amount', 'region'], rows);
    assert.ok(drift(encoder, rows).every((d) => d.level === 'stable' && d.psi < 0.01));
    const shifted = rows.map((r) => [Number(r[0]) + 60, 'south'] as Value[]);
    assert.deepEqual(drift(encoder, shifted).map((d) => d.level), ['shifted', 'shifted']);
  });
});
