// Probabilistic record matching (decision 2026-11-11; D74): pure, deterministic, bounded.
// Records agreeing on discriminating fields are proposed as pairs, one-to-one; disagreeing ones
// are not; earlier rejections teach a field that agreement there means little.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { comparable, evidenceFrom, inferPairs, PROPOSE_AT } from '../../src/services/resolution/inference.service.ts';

const rec = (object: string, source: number, values: (string | null)[]) => ({ object, source, values: values.map(comparable) });

describe('inferred pairs (D74)', () => {
  test('agreement on both compared fields proposes a pair; disagreement does not', () => {
    const records = [
      rec('o1', 0, ['Zeta Holdings', '12']), rec('o2', 1, ['zeta holdings ', '12']),
      rec('o3', 0, ['Delta', '10']), rec('o4', 1, ['Epsilon', '5']),
    ];
    const out = inferPairs(records, evidenceFrom([], 2));
    assert.deepEqual(out.pairs.map((p) => [p.from, p.to, p.agreement]), [['o1', 'o2', [true, true]]]);
    assert.ok(out.pairs[0]!.probability >= PROPOSE_AT);
  });

  test('records of one system are never paired, and each record joins one pair at most', () => {
    const records = [rec('a', 0, ['X', '1']), rec('b', 0, ['X', '1']), rec('c', 1, ['X', '1'])];
    const out = inferPairs(records, evidenceFrom([], 2));
    assert.equal(out.pairs.length, 1);
    assert.equal(out.pairs[0]!.to, 'c');
  });

  test('a field people kept rejecting matches on teaches the next inference', () => {
    const rejectedAgreeing = Array.from({ length: 30 }, () => ({ confirmed: false, agreement: [true, true] }));
    const records = [rec('o1', 0, ['Common Name', 'London']), rec('o2', 1, ['common name', 'london'])];
    assert.equal(inferPairs(records, evidenceFrom([], 2)).pairs.length, 1, 'with no history, agreement on both is enough');
    assert.equal(inferPairs(records, evidenceFrom(rejectedAgreeing, 2)).pairs.length, 0, 'after thirty rejections of pairs that agreed, it is not');
  });
});
