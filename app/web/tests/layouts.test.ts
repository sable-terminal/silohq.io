// The canvas layouts as pure functions (spec 29.2 to 29.4): what each places, what it names as
// not placed and why, and the drawing aids the canvas adds to the server's engine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { layout, mercator, readGridReference, readPoint, SPACING } from '../src/canvas/layouts.canvas.ts';
import { clusterText, countsText, levelOfDetail, type Drawn } from '../src/canvas/lod.canvas.ts';
import { enclosed, nearest, within } from '../src/canvas/navigate.canvas.ts';

const nodes = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `n${i}` }));

describe('the canvas layouts (spec 29.2)', () => {
  test('layered: the edge closing a cycle is named, to be drawn distinctly; every node in a cluster', () => {
    const out = layout({ kind: 'graph_layered', nodes: nodes(4), edges: [[0, 1], [1, 2], [2, 0], [2, 3]] });
    assert.deepEqual(out.backEdges, [2]);
    assert.ok(out.positions.every((p) => p !== null));
    assert.ok(out.positions[1]![0] > out.positions[0]![0] && out.positions[2]![0] > out.positions[1]![0]);
    assert.ok(out.clusters.every((c) => typeof c === 'number'));
  });

  test('hierarchy: nested regions to three levels, an indented tree beyond; each member\'s container', () => {
    // 0 > 1 > 2 > 3 > 4: regions for 0, 1 and 2 (depths 0 to 2), none for 3.
    const out = layout({ kind: 'hierarchy', nodes: nodes(5), edges: [[0, 1], [1, 2], [2, 3], [3, 4]] });
    assert.deepEqual(out.parents, [-1, 0, 1, 2, 3]);
    assert.deepEqual(out.regions.map((r) => [r.index, r.depth]), [[0, 0], [1, 1], [2, 2]]);
    const outer = out.regions[0]!;
    for (const p of out.positions) assert.ok(p![0] >= outer.x0 && p![0] <= outer.x1 && p![1] >= outer.y0 && p![1] <= outer.y1, 'a region holds everything it contains');
  });

  test('timeline: the present marked, what is to come labelled expected, a member without a time not placed', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    const out = layout({
      kind: 'timeline', now,
      nodes: [{ id: 'a', time: now - 86_400_000, lane: 'North' }, { id: 'b', time: now + 86_400_000, lane: 'South' }, { id: 'c', time: null, lane: 'North' }],
      edges: [],
    });
    assert.deepEqual(out.expected, [1]);
    assert.deepEqual(out.notPlaced, [{ index: 2, reason: 'it has no time' }]);
    const mark = out.marks[0]!;
    assert.equal(mark.text, 'Now');
    assert.ok(out.positions[0]![0] < mark.x0 && mark.x0 < out.positions[1]![0], 'the present between the past and the future');
    assert.deepEqual(out.guides.map((g) => g.text), ['North', 'South']);
  });

  test('schematic: stages as columns in their declared order, no stage invented', () => {
    const out = layout({ kind: 'schematic', stageOrder: ['Cut', 'Weld', 'Paint'], edges: [],
      nodes: [{ id: 'a', stage: 'Paint' }, { id: 'b', stage: 'Cut' }, { id: 'c', stage: null }, { id: 'd', stage: 'Cut' }] });
    assert.deepEqual(out.positions, [[2 * SPACING * 3, 0], [0, 0], null, [0, SPACING]]);
    assert.deepEqual(out.notPlaced, [{ index: 2, reason: 'it has no stage' }]);
  });

  test('a plan places what the server placed, and names why for the rest', () => {
    const out = layout({ kind: 'spatial_plan', edges: [], nodes: [{ id: 'a', plan: { x: 10, y: 20 } }, { id: 'b', plan: { reason: 'no anchor places it' } }, { id: 'c' }] });
    assert.deepEqual(out.positions, [[10, 20], null, null]);
    assert.deepEqual(out.notPlaced.map((n) => n.reason), ['no anchor places it', 'the plan has not placed it yet']);
  });
});

describe('positions on a map (spec 29.3)', () => {
  test('WGS 84 in the forms sources give it', () => {
    for (const v of [{ lat: 51.5, lon: -0.1 }, { latitude: 51.5, longitude: -0.1 }, { type: 'Point', coordinates: [-0.1, 51.5] }, [-0.1, 51.5], '51.5,-0.1']) {
      assert.deepEqual(readPoint(v), { lat: 51.5, lon: -0.1 });
    }
    assert.equal(readPoint({ lat: 91, lon: 0 }), undefined);
  });

  test('British National Grid read as WGS 84: the Ordnance Survey\'s worked example, to within ten metres', () => {
    // TG 51409 13177: OSGB36 52°39′27.2531″N 1°43′4.5177″E; WGS 84 52°39′28.72″N 1°42′57.79″E.
    const p = readGridReference({ easting: 651409.903, northing: 313177.270 })!;
    assert.ok(Math.abs(p.lat - (52 + 39 / 60 + 28.72 / 3600)) < 0.0001, String(p.lat));
    assert.ok(Math.abs(p.lon - (1 + 42 / 60 + 57.79 / 3600)) < 0.0001, String(p.lon));
    assert.deepEqual(readGridReference('651409.903,313177.270'), p);
    assert.equal(readGridReference({ easting: -5, northing: 10 }), undefined, 'outside the grid');
  });

  test('another coordinate system is named, not guessed', () => {
    const out = layout({ kind: 'spatial_map', crs: 'EPSG:3035', edges: [], nodes: [{ id: 'a', position: [4_000_000, 3_000_000] }] });
    assert.deepEqual(out.notPlaced, [{ index: 0, reason: 'its coordinates are in EPSG:3035, which the canvas does not convert' }]);
    const grid = layout({ kind: 'spatial_map', crs: 'EPSG:27700', edges: [], nodes: [{ id: 'a', position: { easting: 651409.903, northing: 313177.270 } }] });
    assert.ok(grid.positions[0] !== null);
    assert.ok(mercator({ lon: 0, lat: 0 }).every((v) => Math.abs(v) < 1e-9));
  });
});

describe('level of detail (spec 29.3, 29.8)', () => {
  const at = (id: string, x: number, y: number, state: Drawn['state'] = 'normal', keep = false): Drawn => ({ id, position: [x, y], state, text: id, keep });

  test('a map clusters by a screen grid, with its count per state; the selection is never folded in', () => {
    const nodes = [at('a', 0, 0, 'failed'), at('b', 5, 5), at('c', 8, 2, 'warning'), at('d', 10_000, 0), at('e', 3, 3, 'normal', true)];
    const out = levelOfDetail({ nodes, clusterOf: () => null, kind: 'spatial_map', zoom: 0 });
    assert.equal(out.clusters.length, 1);
    const c = out.clusters[0]!;
    assert.deepEqual([c.count, c.worst, c.members.sort()], [3, 'failed', ['a', 'b', 'c']]);
    assert.equal(clusterText(c), '3 · 1 failed, 1 warning');
    assert.deepEqual(out.points.map((p) => p.id).sort(), ['d', 'e'], 'the kept clone stays on screen');
  });

  test('a graph folds into its own clusters only when too dense to draw, and draws labels only when there is room', () => {
    const nodes = [at('a', 0, 0), at('b', SPACING, 0), at('c', 5 * SPACING, 0)];
    const clusterOf = (id: string) => (id === 'c' ? 2 : 1);
    const far = levelOfDetail({ nodes, clusterOf, kind: 'graph_force', zoom: -6 });
    assert.deepEqual(far.clusters.map((c) => c.members.sort()), [['a', 'b']]);
    assert.equal(far.labels.length, 0, 'no labels at the lowest zoom');
    const near = levelOfDetail({ nodes, clusterOf, kind: 'graph_force', zoom: 0 });
    assert.equal(near.clusters.length, 0);
    assert.equal(near.labels.length, 3);
  });

  test('labels never stand over one another: the more severe wins', () => {
    const out = levelOfDetail({ nodes: [at('quiet one', 0, 0), at('loud one', 2, 0, 'failed')], clusterOf: () => 1, kind: 'graph_force', zoom: 0 });
    assert.deepEqual(out.labels.map((l) => l.id), ['loud one']);
    assert.equal(countsText({ failed: 1, warning: 0, unknown: 0, stale: 0, normal: 199 }), '1 failed, 199 normal');
  });
});

describe('moving about the canvas (spec 29.6, 29.9)', () => {
  const points = [{ id: 'east', position: [10, 0] as [number, number] }, { id: 'far-east', position: [30, 1] as [number, number] }, { id: 'north-east', position: [6, -12] as [number, number] }, { id: 'south', position: [0, 10] as [number, number] }];

  test('the nearest clone that way; none where nothing lies that way', () => {
    assert.equal(nearest([0, 0], 'right', points), 'east');
    assert.equal(nearest([0, 0], 'up', points), 'north-east');
    assert.equal(nearest([0, 0], 'down', points), 'south');
    assert.equal(nearest([0, 0], 'left', points), undefined);
  });

  test('focus mode\'s neighbourhood, one to three links deep, either way along them', () => {
    const edges: [string, string][] = [['a', 'b'], ['b', 'c'], ['d', 'c'], ['d', 'e']];
    assert.deepEqual([...within('a', edges, 1)].sort(), ['a', 'b']);
    assert.deepEqual([...within('a', edges, 3)].sort(), ['a', 'b', 'c', 'd']);
  });

  test('a box or lasso encloses what lies inside it on screen', () => {
    const shown = [{ id: 'in', screen: [5, 5] as [number, number] }, { id: 'out', screen: [20, 5] as [number, number] }, { id: 'notch', screen: [9, 9] as [number, number] }];
    assert.deepEqual(enclosed([[0, 0], [10, 0], [10, 10], [0, 10]], shown), ['in', 'notch']);
    assert.deepEqual(enclosed([[0, 0], [12, 0], [0, 12]], shown), ['in'], 'a triangle leaves the corner out');
  });
});
