// Results as chapter 31 says, without a browser: the signals read from a result object alone, the
// precedence that chooses among the archetypes that fit, a tile's fallback below an archetype's
// minimum legible size, and prose assembled from the result and nothing else.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proseOf, type Names } from '../src/results/prose.result.ts';
import { chosenOf, shapeOf, tileArchetype, type Result } from '../src/results/structure.result.ts';

const T = '00000000-0000-7000-8000-000000000001';
const P = (n: number) => `00000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
const C1 = '00000000-0000-7000-8000-000000000201';
const C2 = '00000000-0000-7000-8000-000000000202';

const column = (n: number, apiName: string, dataType: string) => ({ node: 0, property: P(n), apiName, displayName: apiName.replace('_', ' '), dataType, effect: 'allow' }) as Result['columns'][number];
const lineage = (n: number, apiName: string, connections: string[]) => ({
  node: 0, objectTypeVersionId: T, ontologyVersionId: T, branchId: T, propertyIdentityId: P(n), propertyApiName: apiName,
  sources: connections.map((connectionId) => ({ connectionId, connectorVersion: '1.0.0', sourceObject: 'suppliers', fieldPath: apiName, readAt: '2026-11-24T10:00:00Z', pushdown: { filter: true, sort: false, aggregate: false } })),
}) as Result['lineage'][number];
const coverage = { objects: 0, unmatched: 0, disputed: {}, empty: {}, unchecked: {}, excludedByDispute: 0 };

function result(over: Partial<Result>): Result {
  return {
    queryId: T, planHash: '0'.repeat(64), ontologyVersionId: T, kind: 'groups', columns: [], measures: [], population: 0, total: 0,
    page: { index: 0, count: 1, objects: [], groups: [] }, coverage, lineage: [], periods: [], localFilters: [], reduced: false, aggregateForm: 'merged',
    defaults: { timeFields: [], routes: [] }, cached: false, computedAt: '2026-11-24T10:00:00Z', ...over,
  } as Result;
}
const object = (id: string, values: Record<string, unknown>, extra: Partial<Result['page']['objects'][number]> = {}) => ({
  id, objectTypeId: T, values, states: {}, disputed: [], masked: [], redacted: [], unmatched: false, links: {}, ...extra,
}) as Result['page']['objects'][number];
const names: Names = { property: (id) => ({ [P(2)]: 'Amount', [P(3)]: 'Rating' })[id], type: (_id, many) => (many ? 'Suppliers' : 'Supplier'), connection: (id) => (id === C1 ? 'Ledger' : 'CRM') };

test('one number over no groups is a Figure; over groups a Ranking; over a time key a Series', () => {
  const total = result({ measures: [{ as: 'total', fn: 'sum', node: 0, property: P(2) }], total: 1, page: { index: 0, count: 1, objects: [], groups: [{ key: {}, measures: { total: 1200 }, objects: 7, excluded: {} }] } });
  assert.equal(chosenOf(shapeOf(total)), 'figure');

  const byRegion = result({
    columns: [column(1, 'region', 'string')], measures: [{ as: 'total', fn: 'avg', node: 0, property: P(2) }], total: 3,
    page: { index: 0, count: 1, objects: [], groups: [
      { key: { region: 'North' }, measures: { total: 40 }, objects: 4, excluded: {} },
      { key: { region: 'South' }, measures: { total: 25 }, objects: 2, excluded: {} },
      { key: { region: 'East' }, measures: { total: 10 }, objects: 1, excluded: {} },
    ] },
  });
  const shape = shapeOf(byRegion);
  assert.equal(chosenOf(shape), 'ranking', 'an average does not sum to a whole');
  assert.deepEqual(shape.fits, ['ranking', 'table']);

  const byMonth = result({
    columns: [column(1, 'month', 'date')], measures: [{ as: 'total', fn: 'sum', node: 0, property: P(2) }], total: 3,
    page: { index: 0, count: 1, objects: [], groups: [
      { key: { month: '2026-09-01' }, measures: { total: 10 }, objects: 1, excluded: {} },
      { key: { month: '2026-10-01' }, measures: { total: 30 }, objects: 3, excluded: {} },
      { key: { month: '2026-11-01' }, measures: { total: 20 }, objects: 2, excluded: {} },
    ] },
  });
  const series = shapeOf(byMonth);
  assert.equal(chosenOf(series), 'series');
  assert.equal(series.structure.orderedByTime, true);
  assert.ok(series.fits.includes('composition'), 'a sum over one key, all parts here and none negative, is also parts of a whole');
});

test('a sum over parts is a Composition; a result of more than one page is only a Table', () => {
  const parts = result({
    columns: [column(1, 'status', 'enum')], measures: [{ as: 'n', fn: 'count', node: 0 }], total: 2,
    page: { index: 0, count: 1, objects: [], groups: [{ key: { status: 'open' }, measures: { n: 3 }, objects: 3, excluded: {} }, { key: { status: 'closed' }, measures: { n: 9 }, objects: 9, excluded: {} }] },
  });
  assert.equal(chosenOf(shapeOf(parts)), 'ranking', 'Ranking precedes Composition');
  assert.ok(shapeOf(parts).fits.includes('composition'));
  const paged = result({ ...parts, page: { ...parts.page, count: 3 }, total: 250 });
  assert.deepEqual(shapeOf(paged).fits, ['table'], 'a picture of part of an answer would mislead');
});

test('rows linked to rows: a path is a Chain, a tree a Hierarchy, a cycle a Network', () => {
  const linked = (edges: [string, string][]) => {
    const ids = [...new Set(edges.flat())];
    return result({
      kind: 'objects', columns: [column(1, 'name', 'string')], total: ids.length,
      page: { index: 0, count: 1, groups: [], objects: ids.map((id) => object(id, { name: id }, { links: { next: edges.filter(([a]) => a === id).map(([, b]) => object(b, { name: b })) } })) },
    });
  };
  assert.equal(chosenOf(shapeOf(linked([['a', 'b'], ['b', 'c'], ['c', 'd']]))), 'chain');
  assert.equal(chosenOf(shapeOf(linked([['a', 'b'], ['a', 'c'], ['b', 'd']]))), 'hierarchy');
  const cycle = shapeOf(linked([['a', 'b'], ['b', 'c'], ['c', 'a']]));
  assert.equal(cycle.structure.hasCycle, true);
  assert.equal(chosenOf(cycle), 'network');
});

test('a measure two systems hold and disagree on is a Comparison, first of all', () => {
  const r = result({
    kind: 'objects', columns: [column(1, 'name', 'string'), column(2, 'amount', 'money')], total: 2,
    lineage: [lineage(1, 'name', [C1]), lineage(2, 'amount', [C1, C2])],
    coverage: { ...coverage, disputed: { amount: 1 } },
    page: { index: 0, count: 1, groups: [], objects: [object('a', { name: 'Acme', amount: 10 }, { disputed: ['amount'] }), object('b', { name: 'Brill', amount: 20 })] },
  });
  const shape = shapeOf(r);
  assert.equal(chosenOf(shape), 'comparison');
  assert.equal(shape.disputed?.apiName, 'amount');
  assert.equal(shapeOf({ ...r, coverage }).structure.measureFromTwoSources, false, 'two systems that agree here are not a comparison');
});

test('a tile below its archetype\'s minimum legible size falls back, and says why', () => {
  const byRegion = result({
    columns: [column(1, 'region', 'string')], measures: [{ as: 'total', fn: 'avg', node: 0, property: P(2) }], total: 2,
    page: { index: 0, count: 1, objects: [], groups: [{ key: { region: 'North' }, measures: { total: 4 }, objects: 4, excluded: {} }, { key: { region: 'South' }, measures: { total: 2 }, objects: 2, excluded: {} }] },
  });
  const shape = shapeOf(byRegion);
  assert.deepEqual(tileArchetype(shape, 'ranking', { w: 4, h: 4 }), { archetype: 'ranking' });
  assert.deepEqual(tileArchetype(shape, 'ranking', { w: 2, h: 4 }), { archetype: 'table', fallback: { from: 'ranking', to: 'table', reason: 'below_minimum_size' } });
  const one = result({ measures: [{ as: 't', fn: 'sum', node: 0, property: P(2) }], total: 1, page: { index: 0, count: 1, objects: [], groups: [{ key: {}, measures: { t: 5 }, objects: 5, excluded: {} }] } });
  assert.deepEqual(tileArchetype(shapeOf(one), 'figure', { w: 1, h: 1 }), { archetype: 'figure' }, 'Figure and Table never fall back');
});

test('prose is assembled from the result alone: the figures, the systems and when, and what was left out', () => {
  const r = result({
    columns: [column(1, 'region', 'string')], measures: [{ as: 'total', fn: 'sum', node: 0, property: P(2) }], total: 2,
    lineage: [lineage(1, 'region', [C1]), lineage(2, 'amount', [C1, C2])],
    coverage: { ...coverage, unmatched: 2 },
    page: { index: 0, count: 1, objects: [], groups: [{ key: { region: 'North' }, measures: { total: 300 }, objects: 4, excluded: { total: 1 } }, { key: { region: 'South' }, measures: { total: 100 }, objects: 2, excluded: {} }] },
  });
  const prose = proseOf(r, shapeOf(r), names);
  assert.match(prose[0]!, /^Total amount by region: highest North \(300\) and South \(100\); 2 groups in all\.$/);
  assert.ok(prose.includes('North is 75% of the 400 in all.'));
  assert.ok(prose.some((s) => /^1 value left out of total amount, disputed or empty\.$/.test(s)));
  assert.ok(prose.some((s) => s.startsWith('Read from Ledger and CRM, ')));
  assert.ok(prose.includes('2 records could not be matched to an object.'));
});
