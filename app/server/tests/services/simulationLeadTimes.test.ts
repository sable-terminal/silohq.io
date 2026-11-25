// Observed lead times (spec 39.3, 67.4): elapsed time from an upstream transition to the
// next downstream transition on each linked object, before the upstream object moves again;
// the distribution and sample size; the median as the proposed lead time.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { distributionOf, durationOf, pairLeadTimes } from '../../src/services/simulation/leadTimes.service.ts';

const at = (hours: number) => new Date(Date.UTC(2026, 9, 1) + hours * 3_600_000).toISOString();

describe('observed lead times (spec 39.3)', () => {
  test('each upstream transition pairs with the next downstream transition of each linked object, before the upstream object moves again', () => {
    const upstream = [{ objectRef: 'po-1', observedAt: at(0) }, { objectRef: 'po-1', observedAt: at(10) }, { objectRef: 'po-2', observedAt: at(0) }];
    const downstream = [
      { objectRef: 'd-1', observedAt: at(3) }, { objectRef: 'd-1', observedAt: at(4) }, { objectRef: 'd-1', observedAt: at(15) },
      { objectRef: 'd-2', observedAt: at(-1) }, { objectRef: 'd-2', observedAt: at(12) },
      { objectRef: 'd-3', observedAt: at(5) },
    ];
    const links = new Map([['po-1', ['d-1', 'd-2']], ['po-2', ['d-3']]]);
    assert.deepEqual(pairLeadTimes(upstream, downstream, links).map((s) => s / 3600).sort((a, b) => a - b), [2, 3, 5, 5],
      'po-1 at 0: d-1 after 3h (d-2 moves only after po-1 moved again); po-1 at 10: d-1 after 5h, d-2 after 2h; po-2: d-3 after 5h');
    assert.deepEqual(pairLeadTimes(upstream, downstream, new Map()), [], 'no link, no observation');
  });

  test('the distribution by nearest rank, and the median as a lead time in its largest whole unit', () => {
    const d = distributionOf(Array.from({ length: 40 }, (_, i) => (i + 1) * 3600));
    assert.deepEqual(d, { observations: 40, min: 3600, p10: 4 * 3600, p50: 20 * 3600, p90: 36 * 3600, max: 40 * 3600 });
    assert.deepEqual(durationOf(d.p50), { value: 20, unit: 'hours' });
    assert.deepEqual(durationOf(3 * 86_400 + 43_200), { value: 3.5, unit: 'days' });
    assert.deepEqual(durationOf(90), { value: 1.5, unit: 'minutes' });
  });
});
