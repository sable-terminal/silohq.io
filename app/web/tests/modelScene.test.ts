// The 3D asset view's pure parts (spec 29.5; D228): clones grouped by the node they stand on, each
// group's worst state and counts; the camera distance that frames a part; labels that fit.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fittingLabels, frameDistance, nodeGroups } from '../src/canvas/modelScene.canvas.ts';

describe('the 3D asset view (29.5; D228)', () => {
  test('clones by their node: one alone, several with their counts and the worst state; an unplaced one in none', () => {
    const groups = nodeGroups(
      [{ id: 'a', state: 'normal' }, { id: 'b', state: 'failed' }, { id: 'c', state: 'warning' }, { id: 'd', state: 'normal' }],
      new Map([['a', 'Pump_1'], ['b', 'Pump_2'], ['c', 'Pump_2']]),
    );
    assert.deepEqual(groups.map((g) => [g.node, g.ids, g.worst]), [['Pump_1', ['a'], 'normal'], ['Pump_2', ['b', 'c'], 'failed']]);
    assert.deepEqual(groups[1]!.states, { normal: 0, warning: 1, failed: 1, unknown: 0, stale: 0 });
  });

  test('framing: a part fills the view with a margin, whichever of width or height is tighter', () => {
    const square = frameDistance(1, 90, 1);
    assert.ok(Math.abs(square - Math.SQRT2 * 1.15) < 1e-9, String(square));
    assert.ok(frameDistance(1, 45, 0.5) > frameDistance(1, 45, 2), 'a narrow view stands further back');
  });

  test('labels: the selection kept, then the most severe, none overlapping', () => {
    const shown = fittingLabels([
      { id: 'normal', x: 0, y: 0, width: 50, height: 16, keep: false, rank: 4 },
      { id: 'failed', x: 10, y: 4, width: 50, height: 16, keep: false, rank: 0 },
      { id: 'selected', x: 30, y: 8, width: 50, height: 16, keep: true, rank: 4 },
      { id: 'apart', x: 200, y: 0, width: 50, height: 16, keep: false, rank: 4 },
    ]);
    assert.deepEqual([...shown].sort(), ['apart', 'selected']);
  });
});
