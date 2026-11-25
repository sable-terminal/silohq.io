// The deterministic walk (spec 39.4, 39.6) on its own, over a fake link reader.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { walk, type WalkEdge, type WalkInput } from '../../src/services/simulation/propagation.service.ts';

const DAY = 86_400;
const edge = (id: string, from: string, to: string, extra: Partial<WalkEdge> = {}): WalkEdge => ({
  id, from, to, via: `l_${id}`, kind: 'hard', source: 'stated', status: 'confirmed', leadSeconds: DAY, bufferSeconds: 0, ...extra,
});

function input(edges: WalkEdge[], links: Record<string, Record<string, string[]>>, extra: Partial<WalkInput> = {}): WalkInput {
  return {
    origins: [{ objectTypeId: 'A', objectId: 'a1', delaySeconds: null }], bounds: { hops: 4, fanOut: 100 },
    edgesFrom: async (types) => edges.filter((e) => types.includes(e.from)), cleared: () => true,
    links: async (e) => ({ kind: 'links', links: new Map(Object.entries(links[e.id] ?? {})) }),
    ...extra,
  };
}

describe('the walk (spec 39.4)', () => {
  test('hard edges fail what they reach; a soft edge delays it and the walk continues delayed; paths are kept apart', async () => {
    const out = await walk(input(
      [edge('e1', 'A', 'B'), edge('e2', 'B', 'C', { kind: 'soft', leadSeconds: 3 * DAY, bufferSeconds: DAY }), edge('e3', 'C', 'D')],
      { e1: { a1: ['b1'] }, e2: { b1: ['c1'] }, e3: { c1: ['d1'] } }));
    const by = (id: string) => out.reached.find((r) => r.objectId === id)!;
    assert.equal(by('b1').delaySeconds, null);
    assert.equal(by('b1').viaSoftEdge, false);
    assert.equal(by('c1').delaySeconds, 2 * DAY);
    assert.equal(by('c1').viaSoftEdge, true);
    assert.equal(by('d1').delaySeconds, 2 * DAY, 'a hard edge carries a delay on, less its buffer');
    assert.deepEqual(by('d1').path.map((e) => e.id), ['e1', 'e2', 'e3']);
  });

  test('an object reached both ways appears once on each side', async () => {
    const out = await walk(input([edge('h', 'A', 'B'), edge('s', 'A', 'B', { kind: 'soft' })], { h: { a1: ['b1'] }, s: { a1: ['b1'] } }));
    assert.deepEqual(out.reached.map((r) => [r.objectId, r.viaSoftEdge]).sort(), [['b1', false], ['b1', true]]);
  });

  test('a delay ends where a buffer absorbs it', async () => {
    const out = await walk(input([edge('e1', 'A', 'B', { bufferSeconds: 2 * DAY })], { e1: { a1: ['b1'] } }, { origins: [{ objectTypeId: 'A', objectId: 'a1', delaySeconds: DAY }] }));
    assert.deepEqual(out.reached, []);
  });

  test('stops: an unconfirmed edge and an uncleared type are reported, never crossed; resource edges are counted', async () => {
    const out = await walk(input(
      [edge('e1', 'A', 'B', { status: 'proposed' }), edge('e2', 'A', 'C'), edge('e3', 'A', 'D', { kind: 'resource' })],
      { e1: { a1: ['b1'] }, e2: { a1: ['c1'] }, e3: { a1: ['d1'] } }, { cleared: (t) => t !== 'C' }));
    assert.deepEqual(out.reached, []);
    assert.deepEqual(out.stopped, [
      { reason: 'unconfirmed_edge', edgeId: 'e1', objectTypeId: null, hop: null },
      { reason: 'uncleared_object_type', edgeId: null, objectTypeId: 'C', hop: null },
    ]);
    assert.equal(out.resourceEdgesSkipped, 1);
  });

  test('fan-out past the bound takes the hop back out and names it; edges past the last hop are a bound too', async () => {
    const wide = await walk(input([edge('e1', 'A', 'B'), edge('e2', 'B', 'C')], { e1: { a1: ['b1'] }, e2: { b1: ['c1', 'c2', 'c3'] } },
      { bounds: { hops: 4, fanOut: 2 } }));
    assert.deepEqual(wide.reached.map((r) => r.objectId), ['b1']);
    assert.equal(wide.boundedAtHop, 2);
    const deep = await walk(input([edge('e1', 'A', 'B'), edge('e2', 'B', 'C')], { e1: { a1: ['b1'] }, e2: { b1: ['c1'] } }, { bounds: { hops: 1, fanOut: 10 } }));
    assert.deepEqual(deep.reached.map((r) => r.objectId), ['b1']);
    assert.equal(deep.boundedAtHop, 2);
    assert.deepEqual(deep.stopped, [{ reason: 'bounded_hop', edgeId: null, objectTypeId: null, hop: 2 }]);
  });

  test('a source over its bound stops the walk at that hop', async () => {
    const out = await walk(input([edge('e1', 'A', 'B')], {}, { links: async () => ({ kind: 'bounded' }) }));
    assert.equal(out.boundedAtHop, 1);
    assert.deepEqual(out.reached, []);
  });
});
