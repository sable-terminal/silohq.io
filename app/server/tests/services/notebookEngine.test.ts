// A notebook's statistics and charts (D239): quantiles between neighbours; a column numeric only
// where every value is a number; bars counted or summed, a histogram's bins, points that need both
// numbers; what cannot be drawn counted as omitted.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chartOf, quantileOf, statsOf } from '../../src/services/workspace/notebookEngine.service.ts';

const table = {
  columns: ['region', 'rating', 'name'],
  rows: [['north', 10, 'Acme'], ['south', 11, 'Brill'], ['north', 12, 'Cobalt'], ['east', '13', 'Delta'], ['north', null, 'Echo'], ['west', 'n/a', 'Foxtrot']],
};

describe('notebook statistics and charts (D239)', () => {
  test('quantiles interpolate between neighbours', () => {
    assert.equal(quantileOf([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantileOf([1, 2, 3, 4, 5], 0.9), 4.6);
    assert.ok(Number.isNaN(quantileOf([], 0.5)));
  });

  test('a column\'s counts, empties, distinct values and top values; numeric only where every value is a number', () => {
    const [region, rating] = statsOf(table, ['region', 'rating']);
    assert.deepEqual([region!.count, region!.empty, region!.distinct, region!.numeric], [6, 0, 4, null]);
    assert.deepEqual(region!.top[0], { value: 'north', count: 3 });
    assert.equal(rating!.numeric, null, '"n/a" is not a number, so the column is not numeric');
    const [clean] = statsOf({ columns: ['rating'], rows: [[10], [11], [12], ['13'], [null]] }, []);
    assert.deepEqual([clean!.empty, clean!.numeric?.min, clean!.numeric?.max, clean!.numeric?.mean, clean!.numeric?.median], [1, 10, 13, 11.5, 11.5]);
    assert.ok(Math.abs(clean!.numeric!.stddev - 1.2909944) < 1e-6);
    assert.throws(() => statsOf(table, ['nope']), /no column nope/);
  });

  test('bars count or sum per category, largest first; what cannot be summed is omitted', () => {
    assert.deepEqual(chartOf(table, { chart: 'bar', x: 'region', y: null, bins: 20 }),
      { kind: 'chart', bars: [{ label: 'north', value: 3 }, { label: 'east', value: 1 }, { label: 'south', value: 1 }, { label: 'west', value: 1 }], omitted: 0 });
    assert.deepEqual(chartOf(table, { chart: 'bar', x: 'region', y: 'rating', bins: 20 }),
      { kind: 'chart', bars: [{ label: 'north', value: 22 }, { label: 'east', value: 13 }, { label: 'south', value: 11 }], omitted: 2 });
  });

  test('a histogram bins numbers between the least and greatest; points need both numbers, a line sorted by x', () => {
    const h = chartOf({ columns: ['v'], rows: [[0], [1], [2], [3], [4], ['x']] }, { chart: 'histogram', x: 'v', y: null, bins: 2 });
    assert.deepEqual(h, { kind: 'chart', bins: [{ from: 0, to: 2, count: 2 }, { from: 2, to: 4, count: 3 }], omitted: 1 });
    const line = chartOf({ columns: ['x', 'y'], rows: [[3, 1], [1, 2], ['a', 3], [2, null]] }, { chart: 'line', x: 'x', y: 'y', bins: 20 });
    assert.deepEqual(line, { kind: 'chart', points: [[1, 2], [3, 1]], omitted: 2 });
    assert.throws(() => chartOf(table, { chart: 'scatter', x: 'rating', y: null, bins: 20 }), /plots a y column/);
  });
});
