// Confidence bands per proposal kind from measured acceptance (spec 52.3), as a Beta-Binomial
// question: a band's threshold moves only where the evidence is 95% sure of its rate, and is
// withdrawn only where the evidence is strongly against it; otherwise the fixed bands hold.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bandWith, FIXED_BANDS, thresholdsFrom } from '../../src/services/fde-orchestrator/bands.service.ts';
import { workingDays } from '../../src/services/fde-orchestrator/metrics.service.ts';

const decided = (rows: [number, string, number][]) => rows.flatMap(([confidence, status, n]) => Array.from({ length: n }, () => ({ confidence, status })));

describe('band thresholds from measured acceptance (spec 52.3)', () => {
  test('a kind with no decisions, or evidence only above them, keeps the fixed bands', () => {
    assert.deepEqual(thresholdsFrom([]), { ...FIXED_BANDS, measured: false });
    assert.deepEqual(thresholdsFrom(decided([[0.95, 'accepted', 19]])), { ...FIXED_BANDS, measured: false }, '19 of 19 is not yet 95% sure of nine in ten');
  });

  test('a kind people trust earns a lower threshold: forty accepted unchanged at 0.7', () => {
    const t = thresholdsFrom(decided([[0.7, 'accepted', 40]]));
    assert.equal(t.high, 0.7);
    assert.equal(bandWith(0.72, t), 'high');
  });

  test('mixed evidence moves nothing it does not support', () => {
    const t = thresholdsFrom(decided([
      [0.95, 'accepted', 10], [0.8, 'accepted', 9], [0.8, 'rejected', 1], [0.7, 'accepted_edited', 5], [0.7, 'rejected', 5], [0.5, 'rejected', 12],
    ]));
    assert.deepEqual([t.high, t.medium], [FIXED_BANDS.high, FIXED_BANDS.medium]);
    assert.deepEqual([bandWith(0.9, t), bandWith(0.65, t), bandWith(0.5, t)], ['high', 'medium', 'low']);
  });

  test('working days turn at local midnight in the organisation\'s time zone (54.3)', () => {
    // Friday 20:00 UTC to Monday 04:00 UTC: in UTC four hours of Friday and four of Monday; in Sydney (UTC+11) it is Saturday 07:00 to Monday 15:00, so fifteen hours of Monday.
    assert.equal(workingDays('2026-11-06T20:00:00Z', '2026-11-09T04:00:00Z') * 24, 8);
    assert.equal(workingDays('2026-11-06T20:00:00Z', '2026-11-09T04:00:00Z', 'Australia/Sydney') * 24, 15);
  });

  test('a kind people keep rejecting earns no high band at any confidence', () => {
    const t = thresholdsFrom(decided([[0.99, 'rejected', 15], [0.9, 'accepted', 10]]));
    assert.equal(bandWith(0.99, t), 'low');
  });
});
