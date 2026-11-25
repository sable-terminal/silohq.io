// A Studio chart as the steps of an analysis (spec 37.8; services/studio/chartSteps.service.ts):
// the set's CEL filter read for the viewer's values into typed filters with placeholder values, the
// links it follows, facet narrowing, then the chart's measure. A part with no typed form is said not
// to be steps, naming it; never approximated.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import type { AppDefinition } from '../../src/contracts/studio/definition.contract.ts';
import { stepsOfChart, type ChartSteps } from '../../src/services/studio/chartSteps.service.ts';

const T = { order: '00000000-0000-7000-8000-0000000000a1', supplier: '00000000-0000-7000-8000-0000000000a2', part: '00000000-0000-7000-8000-0000000000a3' };
const L = { supplies: '00000000-0000-7000-8000-0000000000b1', replaces: '00000000-0000-7000-8000-0000000000b2' };
const P = {
  region: '00000000-0000-7000-8000-0000000000c1', status: '00000000-0000-7000-8000-0000000000c2', qty: '00000000-0000-7000-8000-0000000000c3',
  closed: '00000000-0000-7000-8000-0000000000c4', name: '00000000-0000-7000-8000-0000000000c5', due: '00000000-0000-7000-8000-0000000000c6',
  minimum: '00000000-0000-7000-8000-0000000000c7', rating: '00000000-0000-7000-8000-0000000000c8', place: '00000000-0000-7000-8000-0000000000c9',
};
const prop = (identityId: string, apiName: string, dataType: string) => ({ identityId, apiName, displayName: apiName[0]!.toUpperCase() + apiName.slice(1), dataType, status: 'active' });
const manifest = {
  objectTypes: [
    { id: T.order, status: 'active', properties: [prop(P.region, 'region', 'enum'), prop(P.status, 'status', 'string'), prop(P.qty, 'qty', 'integer'), prop(P.closed, 'closed', 'boolean'),
      prop(P.name, 'name', 'string'), prop(P.due, 'due', 'date'), prop(P.minimum, 'minimum', 'integer'), prop(P.place, 'place', 'geopoint')] },
    { id: T.supplier, status: 'active', properties: [prop(P.rating, 'rating', 'decimal')] },
    { id: T.part, status: 'active', properties: [] },
  ],
  linkTypes: [
    { id: L.supplies, apiName: 'supplies', status: 'active', fromTypeId: T.supplier, toTypeId: T.order },
    { id: L.replaces, apiName: 'replaces', status: 'active', fromTypeId: T.part, toTypeId: T.part },
  ],
} as unknown as OntologyManifest;
const ALL = Object.values(P);

function app(cel: string | undefined, extra: Partial<{ traversal: { linkTypeId: string; direction: 'forward' | 'reverse' }[]; objectTypeId: string; groupBy: string; measure: object }> = {}): AppDefinition {
  return {
    schemaVersion: '1', ontologyVersion: 1,
    variables: {
      region: { kind: 'parameter', type: 'enumeration', options: ['north', 'south'] },
      least: { kind: 'parameter', type: 'number' },
      set: { kind: 'objectSet', objectTypeId: extra.objectTypeId ?? T.order, ...(cel !== undefined ? { filter: { cel, properties: ALL } } : {}), ...(extra.traversal ? { traversal: extra.traversal } : {}) },
    },
    pages: [{ id: 'home', title: 'Home', widgets: [{ id: 'chart', kind: 'chart', source: 'set', grid: [1, 1, 12, 6], measure: extra.measure ?? { aggregate: 'count' }, ...(extra.groupBy ? { groupBy: extra.groupBy } : {}) }] }],
    events: [],
  } as unknown as AppDefinition;
}

const steps = (cel: string | undefined, values: Record<string, string | number | null> = {}, extra = {}, narrowing?: { facets: Record<string, string>; searched: boolean }) =>
  stepsOfChart(app(cel, extra), 'chart', manifest, narrowing === undefined ? {} : { narrowing }, { region: null, least: null, ...values });
const ok = (out: ReturnType<typeof steps>): ChartSteps => {
  assert.ok(!('code' in out), JSON.stringify(out));
  return out as ChartSteps;
};
const refused = (out: ReturnType<typeof steps>) => {
  assert.ok('code' in out, `expected a refusal, got ${JSON.stringify(out)}`);
  return out as { code: string; reason: string };
};
const filtersOf = (out: ChartSteps) => (out.steps[0] as { filters: unknown[] }).filters;

describe('a chart\'s set filter, read for the viewer\'s values', () => {
  test('"everything until a region is chosen": no filter unset; one region, its value a parameter, once chosen', () => {
    const cel = 'region == null || object.region == region';
    assert.deepEqual(filtersOf(ok(steps(cel))), []);
    const north = ok(steps(cel, { region: 'north' }));
    assert.deepEqual(filtersOf(north), [{ property: P.region, op: 'eq', value: { param: 'p1' } }]);
    assert.deepEqual(north.parameters, { p1: 'north' });
    assert.ok(!JSON.stringify(north.steps).includes('north'), 'the value is never in the steps');
    // The same idiom as a choice.
    assert.deepEqual(filtersOf(ok(steps('region == null ? true : object.region == region', { region: 'south' }))), [{ property: P.region, op: 'eq', value: { param: 'p1' } }]);
  });

  test('a conjunction of comparisons, lists, flags and text tests becomes typed filters', () => {
    const out = ok(steps('object.status in ["open", "held"] && 5 < object.qty && !object.closed && object.name.startsWith("A") && object["due"] <= "2026-12-31"'));
    assert.deepEqual(filtersOf(out), [
      { property: P.status, op: 'in', value: { param: 'p1' } },
      { property: P.qty, op: 'gt', value: { param: 'p2' } },
      { property: P.closed, op: 'eq', value: { param: 'p3' } },
      { property: P.name, op: 'starts_with', value: { param: 'p4' } },
      { property: P.due, op: 'lte', value: { param: 'p5' } },
    ]);
    assert.deepEqual(out.parameters, { p1: ['open', 'held'], p2: 5, p3: false, p4: 'A', p5: '2026-12-31' });
    assert.deepEqual(out.notes, []);
  });

  test('either of two values of one property is one list; a null comparison a null check; arithmetic over parameters evaluated', () => {
    assert.deepEqual(ok(steps('object.region == "north" || object.region == region', { region: 'south' })).parameters, { p1: ['north', 'south'] });
    assert.deepEqual(filtersOf(ok(steps('object.due != null && object.minimum == null'))), [{ property: P.due, op: 'is_not_null' }, { property: P.minimum, op: 'is_null' }]);
    assert.deepEqual(ok(steps('object.qty >= least * 2', { least: 3 })).parameters, { p1: 6 });
    assert.deepEqual(filtersOf(ok(steps('!(object.qty < 3)'))), [{ property: P.qty, op: 'gte', value: { param: 'p1' } }]);
  });

  test('"is not" keeps different objects from CEL\'s, and says so', () => {
    const out = ok(steps('object.status != "closed"'));
    assert.deepEqual(filtersOf(out), [{ property: P.status, op: 'ne', value: { param: 'p1' } }]);
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0]!, /no Status are left out/);
  });

  test('a filter with no typed form is not steps, naming the part', () => {
    const cases: [string, string, Record<string, number | string | null>?][] = [
      ['object.qty > object.minimum', 'studio.chart_filter_two'],
      ['object.qty + 1 > 3', 'studio.chart_filter_shape'],
      ['object.region == "north" || object.qty > 1', 'studio.chart_filter_either'],
      ['object.due < now', 'studio.chart_filter_now'],
      ['object.qty > "5"', 'studio.chart_filter_mismatch'],
      ['object.place == "x"', 'studio.chart_filter_type'],
      ['object.colour == "red"', 'studio.chart_filter_property'],
      ['!(object.status in ["a"])', 'studio.chart_filter_not'],
    ];
    for (const [cel, code] of cases) {
      const r = refused(steps(cel));
      assert.equal(r.code, code, cel);
    }
    assert.match(refused(steps('object.qty + 1 > 3')).reason, /object\.qty \+ 1/, 'the part is named');
  });

  test('a filter that fails or keeps nothing for the values set is said so, not run', () => {
    assert.equal(refused(steps('object.qty > least')).code, 'studio.chart_filter_fails', 'unset: CEL fails on every object');
    assert.deepEqual(filtersOf(ok(steps('least == null || object.qty > least'))), [], 'unless the filter allows for it');
    assert.equal(refused(steps('object.qty > 1 && region == "east"', { region: 'north' })).code, 'studio.chart_filter_never');
    assert.equal(refused(steps('!(object.qty > least)')).code, 'studio.chart_filter_fails', 'a negated failure is not true');
  });
});

describe('the chart\'s steps', () => {
  test('links followed, the viewer\'s facets and search, then the measure by the grouping', () => {
    const out = ok(steps('object.rating >= 10', {}, { objectTypeId: T.supplier, traversal: [{ linkTypeId: L.supplies, direction: 'forward' }], groupBy: P.region, measure: { aggregate: 'sum', property: P.qty } },
      { facets: { [P.qty]: '12', [P.closed]: 'true' }, searched: true }));
    assert.deepEqual(out.steps.map((s) => s.operation), ['filter', 'traverse', 'filter', 'group']);
    assert.deepEqual(out.steps[1], { operation: 'traverse', input: 1, linkTypeId: L.supplies });
    assert.deepEqual(out.steps[2], { operation: 'filter', input: 2, filters: [{ property: P.qty, op: 'eq', value: { param: 'p2' } }, { property: P.closed, op: 'eq', value: { param: 'p3' } }] });
    assert.deepEqual(out.steps[3], { operation: 'group', input: 3, groupBy: [{ property: P.region }], measures: [{ fn: 'sum', property: P.qty, as: 'total' }] });
    assert.deepEqual(out.parameters, { p1: 10, p2: 12, p3: true }, 'a facet\'s text is the property\'s kind of value');
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0]!, /search/);
  });

  test('a count with no filter; a link from a type to itself followed backwards is not a step', () => {
    assert.deepEqual(ok(steps(undefined)).steps, [{ operation: 'filter', base: { objectTypeId: T.order }, filters: [] }, { operation: 'group', input: 1, groupBy: [], measures: [{ fn: 'count', as: 'objects' }] }]);
    assert.equal(refused(steps(undefined, {}, { objectTypeId: T.part, traversal: [{ linkTypeId: L.replaces, direction: 'reverse' }] })).code, 'studio.chart_link_reverse');
    assert.ok(!('code' in steps(undefined, {}, { objectTypeId: T.part, traversal: [{ linkTypeId: L.replaces, direction: 'forward' }] })));
  });

  test('a widget that is not a chart is not found', () => {
    assert.throws(() => stepsOfChart(app(undefined), 'table', manifest, {}, {}), { code: 'studio.chart_not_found' });
  });
});
