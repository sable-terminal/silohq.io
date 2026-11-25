// The query path's rules on their own (spec 26.8, 26.13, 27.3, 27.6, 24.7): period
// resolution against the organisation's calendar, including the two recorded defects ("the
// past year" meaning one day; a date-only field returning tomorrow's rows east of UTC),
// which operators are exact applied after a bounded read, merge by exact match keys with
// disputes, and how values are typed and masked.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ObjectTypeView } from '../../src/contracts/ontology/manifest.contract.ts';
import { queryPlan } from '../../src/contracts/planner/plan.contract.ts';
import { mergeResolvable, mergeSingleSource, organisationNamespace, uuidv5, type Resolve } from '../../src/services/executor/merge.service.ts';
import { objectIdentity } from '../../src/services/actions/store.service.ts';
import { deriveSiloObjectId, sourceIdentifierHash } from '../../src/services/resolution/identity.service.ts';
import { singleSourceObjectId as stateObjectId } from '../../src/services/state-plane/objectIds.service.ts';
import { singleSourceObjectId } from '../../src/utils/siloObjectId.util.ts';
import { masked, satisfies, typed } from '../../src/services/executor/values.service.ts';
import type { TypeAccess } from '../../src/services/planner/access.service.ts';
import { exactLocally, type NodeProgram } from '../../src/services/planner/decompose.service.ts';
import { resolvePeriod, type Calendar } from '../../src/services/planner/period.service.ts';

const london: Calendar = { timeZone: 'Europe/London', financialYearStartMonth: 4, financialYearStartDay: 1, weekStartDay: 1 };
const NOW = Date.parse('2026-11-01T10:00:00Z');
const at = (expression: Parameters<typeof resolvePeriod>[0], basis: 'date' | 'timestamp' = 'date', cal = london, now = NOW, params = {}) =>
  resolvePeriod(expression, basis, cal, now, params);

describe('period resolution (spec 26.8)', () => {
  test('last quarter, this financial year and last financial quarter are the organisation\'s own', () => {
    assert.deepEqual(at({ kind: 'calendar', unit: 'quarter', offset: -1 }), { from: '2026-07-01', to: '2026-10-01', basis: 'date' });
    assert.deepEqual(at({ kind: 'calendar', unit: 'financial_year', offset: 0 }), { from: '2026-04-01', to: '2027-04-01', basis: 'date' });
    assert.deepEqual(at({ kind: 'calendar', unit: 'financial_quarter', offset: -1 }), { from: '2026-07-01', to: '2026-10-01', basis: 'date' });
    assert.deepEqual(at({ kind: 'calendar', unit: 'financial_year', offset: -1 }, 'date', { ...london, financialYearStartMonth: 1 }),
      { from: '2025-01-01', to: '2026-01-01', basis: 'date' });
  });

  test('"the past year" is twelve months ending now, not one day (a recorded defect)', () => {
    assert.deepEqual(at({ kind: 'trailing', unit: 'year', count: 1 }), { from: '2025-11-02', to: '2026-11-02', basis: 'date' });
    const ts = at({ kind: 'trailing', unit: 'year', count: 1 }, 'timestamp');
    assert.ok(!('code' in ts));
    if (!('code' in ts)) assert.equal(ts.from, '2025-11-01T10:00:00.000Z');
    assert.deepEqual(at({ kind: 'trailing', unit: 'day', count: 7 }), { from: '2026-10-26', to: '2026-11-02', basis: 'date' });
  });

  test('a date-only field is a calendar date in the organisation\'s zone, east of UTC too (a recorded defect)', () => {
    const tokyo: Calendar = { ...london, timeZone: 'Asia/Tokyo' };
    // 20:00 UTC on 1 November is 05:00 on 2 November in Tokyo: today there is the 2nd.
    assert.deepEqual(at({ kind: 'calendar', unit: 'day', offset: 0 }, 'date', tokyo, Date.parse('2026-11-01T20:00:00Z')),
      { from: '2026-11-02', to: '2026-11-03', basis: 'date' });
  });

  test('a timestamp field gets the zone\'s midnights, across a clock change', () => {
    assert.deepEqual(at({ kind: 'calendar', unit: 'month', offset: 0 }, 'timestamp'),
      { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', basis: 'timestamp' });
    assert.deepEqual(at({ kind: 'calendar', unit: 'month', offset: -8 }, 'timestamp'),
      { from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T23:00:00.000Z', basis: 'timestamp' }, 'April begins at midnight BST');
  });

  test('weeks begin on the organisation\'s day; to-date runs to today inclusive', () => {
    // 1 November 2026 is a Sunday.
    assert.deepEqual(at({ kind: 'calendar', unit: 'week', offset: 0 }), { from: '2026-10-26', to: '2026-11-02', basis: 'date' });
    assert.deepEqual(at({ kind: 'calendar', unit: 'week', offset: 0 }, 'date', { ...london, weekStartDay: 7 }), { from: '2026-11-01', to: '2026-11-08', basis: 'date' });
    assert.deepEqual(at({ kind: 'to_date', unit: 'year' }), { from: '2026-01-01', to: '2026-11-02', basis: 'date' });
  });

  test('no financial year start: a financial period is refused naming the calendar, never assumed', () => {
    const out = at({ kind: 'calendar', unit: 'financial_year', offset: 0 }, 'date', { ...london, financialYearStartMonth: null });
    assert.ok('code' in out && out.code === 'plan.financial_year_unset');
  });

  test('between takes dates, or instants for a timestamp field; an empty range is refused', () => {
    assert.deepEqual(at({ kind: 'between', from: { param: 'p1' }, to: { param: 'p2' } }, 'date', london, NOW, { p1: '2026-01-01', p2: '2026-02-01' }),
      { from: '2026-01-01', to: '2026-02-01', basis: 'date' });
    assert.deepEqual(at({ kind: 'between', from: { param: 'p1' }, to: { param: 'p2' } }, 'timestamp', london, NOW, { p1: '2026-07-01', p2: '2026-07-02T12:00:00+01:00' }),
      { from: '2026-06-30T23:00:00.000Z', to: '2026-07-02T11:00:00.000Z', basis: 'timestamp' });
    const empty = at({ kind: 'between', from: { param: 'p1' }, to: { param: 'p2' } }, 'date', london, NOW, { p1: '2026-02-01', p2: '2026-01-01' });
    assert.ok('code' in empty && empty.code === 'plan.period_empty');
    const bad = at({ kind: 'between', from: { param: 'p1' }, to: { param: 'p2' } }, 'date', london, NOW, { p1: 'last tuesday', p2: '2026-01-01' });
    assert.ok('code' in bad && bad.code === 'plan.period_value_invalid');
  });
});

describe('the plan schema (spec 26.5, 26.7)', () => {
  const base = { schemaVersion: '1', ontologyVersionId: '019a0000-0000-7000-8000-000000000001' };
  const t = (n: number) => ({ objectTypeId: `019a0000-0000-7000-8000-00000000001${n}` });
  test('hops form a tree from the root; measures and sorts name what exists', () => {
    assert.ok(queryPlan.safeParse({ ...base, nodes: [t(1), t(2)], hops: [{ from: 0, to: 1, linkTypeId: t(3).objectTypeId, routeId: t(4).objectTypeId }] }).success);
    assert.ok(!queryPlan.safeParse({ ...base, nodes: [t(1), t(2)] }).success, 'an unreached node');
    assert.ok(!queryPlan.safeParse({ ...base, nodes: [t(1), t(2)], hops: [{ from: 1, to: 1, linkTypeId: t(3).objectTypeId, routeId: t(4).objectTypeId }] }).success);
    assert.ok(!queryPlan.safeParse({ ...base, nodes: [t(1)], sort: [{ measure: 'spend', direction: 'desc' }] }).success, 'a measure sorts only with an aggregate');
    assert.ok(!queryPlan.safeParse({ ...base, nodes: [{ ...t(1), filters: [{ property: t(5).objectTypeId, op: 'eq' }] }] }).success, 'eq needs a value');
  });
});

describe('exact local filters (spec 27.3)', () => {
  test('equality and null checks on scalars, ranges on numbers and dates; never text ranges or substrings', () => {
    assert.equal(exactLocally('eq', 'string'), true);
    assert.equal(exactLocally('gt', 'decimal'), true);
    assert.equal(exactLocally('lt', 'date'), true);
    assert.equal(exactLocally('gte', 'timestamp'), true);
    assert.equal(exactLocally('gt', 'string'), false, 'collation differs between systems');
    assert.equal(exactLocally('contains', 'string'), false);
    assert.equal(exactLocally('eq', 'struct'), false);
    assert.equal(exactLocally('is_null', 'geopoint'), true);
  });

  test('comparisons are typed: instants by time, not by text', () => {
    assert.equal(satisfies('2026-03-01T09:00:00.000Z', 'lt', '2026-03-01T10:00:00+01:00', 'timestamp'), false, '09:00Z is 10:00 at +01:00');
    assert.equal(satisfies(9, 'lt', 10, 'integer'), true);
    assert.equal(satisfies(null, 'ne', 'x', 'string'), false, 'an empty value matches only is_null');
    assert.equal(satisfies(null, 'is_null', undefined, 'string'), true);
  });
});

describe('values (spec 27.6, 57.4)', () => {
  const mapping = { connectionId: '019a0000-0000-7000-8000-000000000001', sourceObject: 'o', fieldPath: 'f', valueMap: null, sourceTimeZone: null, confidence: 1 };
  test('typed by the property; local time in the source\'s zone; coded fields through their map', () => {
    assert.equal(typed('2026-07-01T09:00:00', 'timestamp', { ...mapping, sourceTimeZone: 'Europe/London' }), '2026-07-01T08:00:00.000Z');
    assert.equal(typed('2026-07-01T09:00:00Z', 'timestamp', mapping), '2026-07-01T09:00:00.000Z');
    assert.equal(typed('12.5', 'decimal', mapping), 12.5);
    assert.equal(typed('12.5', 'integer', mapping), null, 'not an integer: empty, never rounded');
    assert.equal(typed('A', 'enum', { ...mapping, valueMap: { A: 'active' } }), 'active');
    assert.equal(typed('Z', 'enum', { ...mapping, valueMap: { A: 'active' } }), null);
  });

  test('a masked value keeps at most its last four characters', () => {
    assert.equal(masked('4111111111111111'), '****1111');
    assert.equal(masked('abc'), '****');
    assert.equal(masked(42), null);
  });
});

describe('merge through the entity graph, and one object id (spec 23, 24.7, 27.6)', () => {
  const ORG = '019a0000-0000-7000-8000-0000000000aa';
  const A = '019a0000-0000-7000-8000-0000000000a1';
  const B = '019a0000-0000-7000-8000-0000000000b1';
  const id = (n: number) => `019a0000-0000-7000-8000-00000000000${n}`;
  const map = (connectionId: string, sourceObject: string, fieldPath: string) => ({ connectionId, sourceObject, fieldPath, valueMap: null, sourceTimeZone: null, confidence: 1 });
  const property = (n: number, apiName: string, dataType: 'string' | 'integer', mappings: ReturnType<typeof map>[]) => ({
    identityId: id(n), apiName, displayName: apiName, description: null, dataType, typeParams: {}, nullable: true, isMatchKey: apiName === 'reg',
    sharedPropertyId: null, computedFunctionVersionId: null, status: 'active' as const, mappings,
  });
  const supplier = {
    id: id(9), typeVersionId: id(8), apiName: 'supplier', status: 'active', displayName: 'Supplier', pluralName: 'Suppliers', description: null,
    resolutionClass: 'resolvable', matchKeys: [{ propertyIdentityId: id(1), normalisation: 'value.trim()' }], primaryKeyPropertyIdentityId: null,
    titlePropertyIdentityId: id(2), defaultTimeFieldPropertyIdentityId: null,
    contributingObjects: [{ connectionId: A, sourceObject: 'sup', identifierFieldPath: 'id', connectorVersion: '1' }, { connectionId: B, sourceObject: 'ven', identifierFieldPath: 'code', connectorVersion: '1' }],
    properties: [
      property(1, 'reg', 'string', [map(A, 'sup', 'reg'), map(B, 'ven', 'registration')]),
      property(2, 'name', 'string', [map(A, 'sup', 'name'), map(B, 'ven', 'vendor')]),
      property(3, 'rating', 'integer', [map(B, 'ven', 'rating')]),
    ],
    timeFields: [], implements: [], visual: {},
  } as ObjectTypeView;
  const access: TypeAccess = { type: supplier, properties: new Map(supplier.properties.map((p) => [p.identityId, { property: p, effect: 'allow' as const }])), withheld: [] };
  const node = { node: 0, access, mode: 'merged', sources: [], filters: [], period: undefined, restricted: false, reads: new Set([id(1), id(2), id(3)]) } as unknown as NodeProgram;
  const [sa, sb] = supplier.contributingObjects;
  const sup = [{ id: 's1', reg: 'R1', name: 'Acme' }, { id: 's2', reg: ' R2', name: 'Brill plc' }, { id: 's3', reg: null, name: 'Echo' }];
  const ven = [{ code: 'V1', registration: 'R1', vendor: 'Acme', rating: '5' }, { code: 'V2', registration: 'R2 ', vendor: 'Brill Ltd', rating: 3 }];
  const OBJ = (n: number) => `019a0000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
  // A stand-in for resolution: what it would answer for these rows.
  const calls: { sources: { connectionId: string; rows: { identifier: string | number; values: Record<string, unknown> }[] }[] }[] = [];
  const resolve: Resolve = async (body) => {
    calls.push(body as never);
    return {
      objects: [
        { siloObjectId: OBJ(1), redirectedFrom: [], absentFrom: [], rows: [{ source: 0, row: 0 }, { source: 1, row: 0 }],
          properties: { [id(2)]: { state: 'agreed', value: 'Acme' }, [id(3)]: { state: 'only', value: '5', from: B } } },
        { siloObjectId: OBJ(2), redirectedFrom: [], absentFrom: [], rows: [{ source: 0, row: 1 }, { source: 1, row: 1 }],
          properties: { [id(2)]: { state: 'declared', value: 'Brill Ltd', from: B, authorityId: id(7) }, [id(3)]: { state: 'unchecked' } } },
        { siloObjectId: OBJ(3), redirectedFrom: [], absentFrom: [], rows: [{ source: 0, row: 2 }],
          properties: { [id(2)]: { state: 'only', value: 'Echo', from: A }, [id(3)]: { state: 'empty' } } },
      ],
      coverage: { population: 3, decided: 1, disputed: 0, empty: 0, unchecked: 1, byProperty: {} },
      unkeyed: 1,
    } as never;
  };
  const merged = () => mergeResolvable(resolve, ORG, id(6), node, [{ source: sa!, rows: sup }, { source: sb!, rows: ven }]);

  test('a resolvable type takes resolution\'s objects and states, with values typed from the system it names', async () => {
    const objects = await merged();
    const sent = calls.at(-1)!;
    assert.deepEqual(sent.sources.map((s) => s.rows.map((r) => r.identifier)), [['s1', 's2', 's3'], ['V1', 'V2']]);
    assert.deepEqual(sent.sources[1]!.rows[0]!.values, { [id(1)]: 'R1', [id(2)]: 'Acme', [id(3)]: '5' }, 'raw values by property identity');
    const [acme, brill, echo] = objects;
    assert.equal(acme!.id, OBJ(1));
    assert.deepEqual(acme!.values.get(id(3)), { value: 5, state: 'only', from: B }, 'typed here: "5" is the integer 5, from the system resolution named');
    assert.deepEqual(brill!.values.get(id(2)), { value: 'Brill Ltd', state: 'declared', from: B, authorityId: id(7) }, 'field authority named the system and itself');
    assert.deepEqual(brill!.values.get(id(3)), { value: null, state: 'unchecked' }, 'never a value for what was not asked');
    assert.equal(echo!.unmatched, true, 'no key: it stood alone');
    assert.equal(acme!.unmatched, false);
  });

  test('a single-source record has the id every service derives (spec 24.7)', () => {
    const single = { ...supplier, resolutionClass: 'single_source', contributingObjects: [sa!] } as ObjectTypeView;
    const singleNode = { ...node, access: { ...access, type: single } } as unknown as NodeProgram;
    const [object] = mergeSingleSource(ORG, singleNode, [{ source: sa!, rows: [{ id: 's1', reg: 'R1', name: 'Acme' }] }]);
    const expected = singleSourceObjectId(ORG, single.id, A, 'sup', 's1');
    assert.equal(object!.id, expected, 'the executor');
    assert.equal(stateObjectId(ORG, single.id, A, 'sup', 's1'), expected, 'the state plane');
    assert.equal(objectIdentity(ORG, single.id, A, 'sup', 's1'), expected, 'write-back');
    assert.equal(deriveSiloObjectId(ORG, single.id, [sourceIdentifierHash(A, 'sup', 's1')]), expected, 'resolution, for a record keyed by its identifier');
    assert.equal(singleSourceObjectId(ORG, single.id, A, 'sup', 's1'), expected, 'the same on every request');
    assert.notEqual(singleSourceObjectId(ORG, single.id, B, 'sup', 's1'), expected, 'another system, another record');
    assert.equal(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2', 'RFC 9562 test vector');
    assert.notEqual(organisationNamespace(ORG), organisationNamespace(A));
  });

  test('a read over the per-call bound is split by declared key, and an object seen twice is combined conservatively', async () => {
    const many = Array.from({ length: 9_000 }, (_, i) => ({ id: `s${i}`, reg: `R${i}`, name: 'Same' }));
    const sizes: number[] = [];
    const ids = new Set<string>();
    const split: Resolve = async (body) => {
      sizes.push(body.sources[0]!.rows.length);
      // Every call answers object 1 for its first row, so object 1 arrives from each call.
      return {
        objects: body.sources[0]!.rows.map((_, row) => ({
          siloObjectId: row === 0 ? OBJ(1) : (() => { const v = `019a0000-0000-7000-9000-${String(ids.size).padStart(12, '0')}`; ids.add(v); return v; })(),
          redirectedFrom: [], absentFrom: [], rows: [{ source: 0, row }],
          properties: { [id(2)]: row === 0 && sizes.length === 2 ? { state: 'disputed' } : { state: 'only', value: 'Same', from: A } },
        })),
        coverage: { population: 0, decided: 0, disputed: 0, empty: 0, unchecked: 0, byProperty: {} }, unkeyed: 0,
      } as never;
    };
    const objects = await mergeResolvable(split, ORG, id(6), node, [{ source: sa!, rows: many }]);
    assert.ok(sizes.length >= 2 && sizes.every((n) => n <= 5_000), 'every call within the contract\'s bound');
    assert.equal(sizes.reduce((a, b) => a + b, 0), 9_000, 'every row sent once');
    const one = objects.find((o) => o.id === OBJ(1))!;
    assert.equal(one.records.length, sizes.length, 'its rows from every call');
    assert.deepEqual(one.values.get(id(2)), { value: null, state: 'disputed' }, 'one call found it disputed: so is the whole, never a pick');
  });
});
