// Explorer's plans and filters (spec 34.1, 24.4): values travel as parameters, never in the
// plan; a facet's counts are read under the other filters; the same filters become a saved
// object set's CEL predicate; filters survive the address.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnsOf, facetable, filtersFromParam, filtersToParam, objectsPlan, predicateOf, valuesPlan, type Filter } from '../src/utils/plan.util.ts';
import type { ObjectType } from '../src/hooks/vocabulary.hook.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const property = (n: number, apiName: string, dataType: string, effect: 'allow' | 'mask' | 'redact' = 'allow') =>
  ({ identityId: id(n), apiName, displayName: apiName, dataType, description: null, effect, isTimeField: dataType === 'timestamp' }) as ObjectType['properties'][number];
const supplier = {
  id: id(1), apiName: 'supplier', displayName: 'Supplier', pluralName: 'Suppliers', description: null, resolutionClass: 'resolvable', titleProperty: id(11),
  interfaces: [], defaultTimeField: null,
  properties: [property(10, 'rating', 'integer'), property(11, 'name', 'string'), property(12, 'region', 'string'), property(13, 'email', 'string', 'mask'),
    property(14, 'placed', 'timestamp'), property(15, 'active', 'boolean'), property(16, 'tags', 'array')],
} as unknown as ObjectType;
const version = id(99);

test('a table shows the title first; struct and array properties are left out', () => {
  assert.deepEqual(columnsOf(supplier).map((p) => p.apiName), ['name', 'rating', 'region', 'email', 'placed', 'active']);
});

test('a masked property has no facet', () => {
  assert.ok(!facetable(supplier).some((p) => p.apiName === 'email'));
  assert.ok(facetable(supplier).some((p) => p.apiName === 'region'));
});

test('filter values are parameters: the plan holds placeholders only', () => {
  const filters: Filter[] = [{ property: id(12), op: 'in', values: ['north', 'south'] }, { property: id(10), op: 'gte', value: 11 }, { property: id(13), op: 'is_null' }];
  const { plan, parameters } = objectsPlan(version, supplier, filters, { property: id(10), direction: 'desc' });
  assert.deepEqual(plan.nodes[0]!.filters, [
    { property: id(12), op: 'in', value: { param: 'p1' } }, { property: id(10), op: 'gte', value: { param: 'p2' } }, { property: id(13), op: 'is_null' },
  ]);
  assert.deepEqual(parameters, { p1: ['north', 'south'], p2: 11 });
  assert.ok(!JSON.stringify(plan).includes('north'), 'no value in the plan');
  assert.deepEqual(plan.sort, [{ property: id(10), direction: 'desc' }]);
});

test('a facet counts under the other filters, most frequent first', () => {
  const { plan } = valuesPlan(version, supplier, id(12), [{ property: id(10), op: 'gte', value: 11 }]);
  assert.deepEqual(plan.aggregate, { groupBy: [{ node: 0, property: id(12) }], measures: [{ fn: 'count', node: 0, as: 'n' }] });
  assert.deepEqual(plan.sort, [{ measure: 'n', direction: 'desc' }]);
  assert.equal(plan.nodes[0]!.filters!.length, 1);
});

test('the filters as a saved set\'s predicate, quoting strings safely', () => {
  const predicate = predicateOf(supplier, [
    { property: id(12), op: 'in', values: ['north', 'O"Brien\\'] }, { property: id(10), op: 'gte', value: 11 }, { property: id(15), op: 'eq', value: true },
    { property: id(11), op: 'contains', value: 'Ltd' }, { property: id(14), op: 'lte', value: '2026-11-30T23:59:59.999Z' }, { property: id(13), op: 'is_not_null' },
  ]);
  assert.equal(predicate.cel, 'object.region in ["north", "O\\"Brien\\\\"] && object.rating >= 11 && object.active == true'
    + ' && object.name.contains("Ltd") && object.placed <= "2026-11-30T23:59:59.999Z" && object.email != null');
  assert.deepEqual(predicate.properties.sort(), [id(10), id(11), id(12), id(13), id(14), id(15)].sort());
  assert.deepEqual(predicateOf(supplier, []), { cel: 'true', properties: [] }, 'no filter: every object of the type');
});

test('filters survive the address; anything else in it is ignored', () => {
  const filters: Filter[] = [{ property: id(12), op: 'in', values: ['north'] }];
  assert.deepEqual(filtersFromParam(filtersToParam(filters)), filters);
  assert.deepEqual(filtersFromParam('not json'), []);
  assert.deepEqual(filtersFromParam('{"a":1}'), []);
  assert.deepEqual(filtersFromParam(null), []);
});
