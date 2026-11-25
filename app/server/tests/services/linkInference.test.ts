// Inferred links (decision 2026-11-11; D75): a field counts as a link only where the chance
// that nine in ten or more of its distinct values are the other object's identifiers is at
// least 90%; a few values that happen to match never do.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeContainment, MIN_DISTINCT } from '../../src/services/ontology/linkInference.service.ts';

const ids = new Set(Array.from({ length: 200 }, (_, i) => `C${i}`));

describe('inferred links (D75)', () => {
  test('nearly every value an identifier, enough of them: a link', () => {
    const values = Array.from({ length: 60 }, (_, i) => `C${i % 40}`);
    const judged = judgeContainment(values, ids);
    assert.deepEqual([judged?.contained, judged?.distinct], [40, 40]);
    assert.ok(judged!.probability >= 0.9);
  });

  test('too few distinct values, or too many strangers: no link', () => {
    assert.equal(judgeContainment(Array.from({ length: MIN_DISTINCT - 1 }, (_, i) => `C${i}`), ids), undefined);
    assert.equal(judgeContainment(Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? `C${i}` : `X${i}`)), ids), undefined, 'half strangers');
    assert.equal(judgeContainment(Array.from({ length: 12 }, (_, i) => `C${i}`), ids), undefined, 'twelve of twelve is not yet 90% sure of nine in ten');
  });
});
