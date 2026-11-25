// An analysis being built, without a browser (spec 37.8): values become placeholders sealed apart
// from the steps, and come back in place for the person who bound them; each step knows whose
// objects it holds; and each step can be read in words.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupOf, type Vocabulary } from '../src/hooks/vocabulary.hook.ts';
import { draftsOf, lastSet, requestOf, stepWords, typeAt, type StepDraft } from '../src/views/explorer/chain.view.ts';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SUPPLIER = id(1);
const ORDER = id(2);
const prop = (n: number, apiName: string, displayName: string, dataType = 'string') => ({ identityId: id(100 + n), apiName, displayName, dataType, description: null, effect: 'allow', isTimeField: false });
const vocabulary = {
  ontologyVersionId: id(9),
  objectTypes: [
    { id: SUPPLIER, apiName: 'supplier', displayName: 'Supplier', pluralName: 'Suppliers', description: null, resolutionClass: 'single_source', titleProperty: id(101), interfaces: [], defaultTimeField: null,
      properties: [prop(1, 'name', 'Name'), prop(2, 'region', 'Region')] },
    { id: ORDER, apiName: 'order', displayName: 'Order', pluralName: 'Orders', description: null, resolutionClass: 'single_source', titleProperty: id(103), interfaces: [], defaultTimeField: null,
      properties: [prop(3, 'order_id', 'Id'), prop(4, 'units', 'Units', 'integer'), prop(5, 'supplier_id', 'Supplier')] },
  ],
  linkTypes: [{ id: id(50), apiName: 'supplier_orders', forwardName: 'orders', reverseName: 'supplier', fromTypeId: SUPPLIER, toTypeId: ORDER, routes: [{ id: id(51), position: 1 }], defaultRouteId: id(51) }],
  interfaces: [],
} as unknown as Vocabulary;
const lookup = lookupOf(vocabulary);

const steps: StepDraft[] = [
  { operation: 'filter', base: SUPPLIER, filters: [{ property: id(102), op: 'eq', value: 'north' }] },
  { operation: 'traverse', input: 1, linkTypeId: id(50), filters: [{ property: id(104), op: 'gte', value: 2 }] },
  { operation: 'group', input: 2, groupBy: [{ property: id(105) }], measures: [{ fn: 'sum', property: id(104), as: 'units' }] },
  { operation: 'select', input: 3, key: [{ property: id(105), value: 's01' }] },
  { operation: 'compare', inputs: [2, 4], measures: [{ fn: 'count', as: 'how_many' }], bound: 50 },
];

test('every value becomes a placeholder, sealed apart from the steps; it comes back in place', () => {
  const { steps: typed, parameters } = requestOf(steps);
  assert.deepEqual(parameters, { p1: 'north', p2: 2, p3: 's01' });
  assert.deepEqual(typed[0], { operation: 'filter', base: { objectTypeId: SUPPLIER }, filters: [{ property: id(102), op: 'eq', value: { param: 'p1' } }] });
  assert.deepEqual(typed[3], { operation: 'select', input: 3, key: [{ property: id(105), value: { param: 'p3' } }] });
  assert.deepEqual(typed[4], { operation: 'compare', inputs: [2, 4], measures: [{ fn: 'count', as: 'how_many' }], bound: 50 }, 'a count names no property');
  assert.ok(!JSON.stringify(typed).includes('north'), 'no value in the steps');
  const back = draftsOf(typed.map((step) => ({ step, bound: 10 })) as never, parameters);
  assert.deepEqual((back[0] as Extract<StepDraft, { operation: 'filter' }>).filters, steps[0]!.operation === 'filter' ? steps[0]!.filters : []);
  assert.equal((back[3] as Extract<StepDraft, { operation: 'select' }>).key[0]!.value, 's01');
  const theirs = draftsOf(typed.map((step) => ({ step, bound: 10 })) as never, null);
  assert.equal((theirs[0] as Extract<StepDraft, { operation: 'filter' }>).filters[0]!.value, '', 'without the values, empty to fill in');
});

test('each step knows whose objects it holds, through links in either direction', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((p) => typeAt(steps, p, lookup)), [SUPPLIER, ORDER, ORDER, ORDER, ORDER]);
  const back: StepDraft[] = [...steps.slice(0, 2), { operation: 'traverse', input: 2, linkTypeId: id(50), filters: [] }];
  assert.equal(typeAt(back, 3, lookup), SUPPLIER, 'from orders, the link leads back to suppliers');
  assert.equal(lastSet(steps), 4, 'a new step starts from the last set');
});

test('each step in words', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((p) => stepWords(steps, p, lookup)), [
    'Suppliers whose region is north',
    'The orders of step 1 whose units is at least 2',
    'total units of step 2 by supplier',
    'The orders behind supplier s01 in step 3',
    'how many: step 2 against step 4',
  ]);
});
