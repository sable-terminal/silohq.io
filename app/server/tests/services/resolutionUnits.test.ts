// The pure parts of resolution: object identity (UUIDv5, spec 24.7), key normalisation and
// shapes (spec 23.1, 23.2), field authority and coverage (spec 23.4 to 23.6), and the judging
// of candidate rules (a wrong merge is worse than failing to merge).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ObjectTypeView } from '../../src/contracts/ontology/manifest.contract.ts';
import { compileCel } from '../../src/services/expression-evaluator/cel.service.ts';
import { bestCandidate, catalogueSteps, deterministicCandidates, judgeRule, type AnalysisRecord } from '../../src/services/resolution/analysis.service.ts';
import {
  compositeKey, deriveSiloObjectId, keyPlan, keyShape, normalisedComponents, sourceKey, uuidv5,
} from '../../src/services/resolution/identity.service.ts';
import { decimalAt, instant, merge, type MergeSource } from '../../src/services/resolution/merge.service.ts';

const ORG = '0190f5a2-0000-7000-8000-000000000001';
const TYPE = '0190f5a2-0000-7000-8000-000000000002';

describe('identity (spec 24.7)', () => {
  test('UUIDv5 matches the RFC example', () => {
    assert.equal(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  test('an object id is derived from the type and the sorted key hashes, per organisation', () => {
    const a = deriveSiloObjectId(ORG, TYPE, ['bb', 'aa']);
    assert.equal(a, deriveSiloObjectId(ORG, TYPE, ['aa', 'bb']), 'order does not matter');
    assert.notEqual(a, deriveSiloObjectId('0190f5a2-0000-7000-8000-000000000009', TYPE, ['aa', 'bb']), 'another organisation, another id');
    assert.notEqual(a, deriveSiloObjectId(ORG, TYPE, ['aa', 'bb'], 1), 'a taken id gets a counter');
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('keys normalise by the declared expression then the confirmed rules; anything missing or failing is unkeyed', () => {
    const plan = keyPlan([{ propertyIdentityId: 'p1', normalisation: 'value.trim()' }, { propertyIdentityId: 'p2', normalisation: null }],
      ['value.upperAscii()']);
    assert.deepEqual(normalisedComponents(plan, { p1: ' ab-1 ', p2: 42 }), ['AB-1', '42']);
    assert.equal(normalisedComponents(plan, { p1: 'x' }), undefined, 'a missing component');
    assert.equal(normalisedComponents(plan, { p1: '   ', p2: 'y' }), undefined, 'empty after trimming');
    assert.equal(normalisedComponents(keyPlan([{ propertyIdentityId: 'p1', normalisation: 'string(int(value))' }], []), { p1: 'abc' }), undefined,
      'a normalisation that fails');
    assert.notEqual(compositeKey(['a']), sourceKey('c', 'o', 'a'), 'an identifier key never equals a composite');
  });

  test('a key\'s shape is class runs and separators, never the key', () => {
    assert.equal(keyShape('GB-123 456'), 'U2-D3␣D3');
    assert.equal(keyShape('ab12x'), 'L2D2L1');
    assert.equal(keyShape('£5'), 'X1D1');
  });
});

describe('equality by type (spec 23.4)', () => {
  test('decimals at the declared scale, rounded half away from zero', () => {
    assert.equal(decimalAt('100', 2), '100.00');
    assert.equal(decimalAt(100, 2), '100.00');
    assert.equal(decimalAt('1.005', 2), '1.01');
    assert.equal(decimalAt('9.995', 2), '10.00');
    assert.equal(decimalAt('-0.001', 2), '0.00');
    assert.equal(decimalAt('007.50', undefined), '7.5');
    assert.equal(decimalAt('twelve', 2), undefined);
  });

  test('timestamps as instants; a value without an offset read in the source\'s zone', () => {
    assert.equal(instant('2026-06-01T12:00:00', 'Europe/London'), Date.parse('2026-06-01T11:00:00Z'));
    assert.equal(instant('2026-01-15T12:00:00', 'Europe/London'), Date.parse('2026-01-15T12:00:00Z'));
    assert.equal(instant('2026-06-01T12:00:00+02:00', 'Europe/London'), Date.parse('2026-06-01T10:00:00Z'));
    assert.equal(instant('2026-06-01T12:00:00', null), Date.parse('2026-06-01T12:00:00Z'));
  });
});

describe('field authority and coverage (spec 23.4 to 23.6)', () => {
  const property = (identityId: string, apiName: string, dataType: string, mappings: unknown[], typeParams = {}) =>
    ({ identityId, apiName, displayName: apiName, description: null, dataType, typeParams, nullable: true, isMatchKey: false, sharedPropertyId: null,
      computedFunctionVersionId: null, status: 'active', mappings }) as ObjectTypeView['properties'][number];
  const m = (connectionId: string, sourceObject: string, extra: Record<string, unknown> = {}) =>
    ({ connectionId, sourceObject, fieldPath: 'f', valueMap: null, sourceTimeZone: null, confidence: 1, ...extra });
  const type = {
    properties: [
      property('amount', 'amount', 'money', [m('A', 'a'), m('B', 'b')], { scale: 2 }),
      property('name', 'name', 'string', [m('A', 'a'), m('B', 'b')]),
      property('state', 'state', 'enum', [m('A', 'a', { valueMap: { '1': 'open' } }), m('B', 'b', { valueMap: { O: 'open' } })]),
      property('note', 'note', 'string', [m('A', 'a')]),
      property('when', 'when', 'timestamp', [m('A', 'a'), m('B', 'b', { sourceTimeZone: 'Europe/London' })]),
    ],
  } as unknown as ObjectTypeView;
  const sources: MergeSource[] = [
    { connectionId: 'A', sourceObject: 'a', unchecked: false, rows: [
      { values: { amount: { amount: '10', currency: 'gbp' }, name: 'X', state: '1', note: 'n', when: '2026-06-01T11:00:00Z' } },
      { values: { amount: null, name: null, state: null, note: null } },
    ] },
    { connectionId: 'B', sourceObject: 'b', unchecked: true, rows: [
      { values: { amount: { amount: '10.00', currency: 'GBP' }, name: 'Y', state: 'O', when: '2026-06-01T12:00:00' } },
    ] },
  ];
  const all = ['amount', 'name', 'state', 'note', 'when'];

  test('agreed by type, disputed without a value, only, empty and unchecked', () => {
    const out = merge({ type, sources, objects: [{ rows: [{ source: 0, row: 0 }, { source: 1, row: 0 }] }, { rows: [{ source: 0, row: 1 }] }],
      properties: all, authorities: [] });
    const [both, alone] = out.properties as [Record<string, { state: string; value?: unknown }>, Record<string, { state: string }>];
    assert.deepEqual(both['amount'], { state: 'agreed', value: { amount: '10', currency: 'gbp' } }, 'money: amount at scale and currency');
    assert.deepEqual(both['name'], { state: 'disputed' });
    assert.deepEqual(both['state'], { state: 'agreed', value: 'open' }, 'enums after each value map');
    assert.deepEqual(both['note'], { state: 'only', value: 'n', from: 'A' });
    assert.equal(both['when']!.state, 'agreed', 'the same instant in two zones');
    assert.equal(alone['amount']!.state, 'unchecked', 'B returned nothing and could not be asked again');
    assert.equal(alone['note']!.state, 'empty', 'only A maps it, and A holds no reading');
    assert.deepEqual(out.coverage.byProperty['name'], { population: 2, decided: 0, disputed: 1, empty: 0, unchecked: 1 });
    assert.deepEqual({ ...out.coverage, byProperty: undefined }, { population: 2, decided: 0, disputed: 1, empty: 0, unchecked: 1, byProperty: undefined });
  });

  test('a declaration decides, unless its condition fails or its system holds nothing', () => {
    const authorities = [
      { id: 'cond', propertyIdentityId: 'name', winningConnectionId: 'A', condition: compileCel('object.note == "other"', { object: 'map' }) },
      { id: 'plain', propertyIdentityId: 'name', winningConnectionId: 'B', condition: null },
    ];
    const out = merge({ type, sources, objects: [{ rows: [{ source: 0, row: 0 }, { source: 1, row: 0 }] }], properties: ['name'], authorities });
    assert.deepEqual(out.properties[0]!['name'], { state: 'declared', value: 'Y', from: 'B', authorityId: 'plain' }, 'the condition failed, so B wins');
    const onlyA = merge({ type, sources, objects: [{ rows: [{ source: 0, row: 0 }] }], properties: ['name'], authorities: [authorities[1]!] });
    assert.equal(onlyA.properties[0]!['name']!.state, 'unchecked', 'B holds nothing here: no declaration applies');
  });
});

describe('judging candidate rules (spec 23.2)', () => {
  const rec = (source: number, key: string, object = `${source}:${key}`): AnalysisRecord => ({ source, components: [key], object });

  test('a rule is never proposed when it merges within one system or breaks a match', () => {
    const records = [rec(0, 'GB-1'), rec(1, 'GB1'), rec(0, 'GB1'), rec(0, 'AB', 'm'), rec(1, 'AB', 'm')];
    const separators = judgeRule(records, 'value.split("-").join("")')!;
    assert.equal(separators.ambiguous, true, 'GB-1 and GB1 are two records of one system');
    const lossy = judgeRule([rec(0, 'AB', 'm'), rec(1, 'AB', 'm')], 'value == "AB" ? string(1/0) : value')!;
    assert.equal(lossy.lost, 1, 'a match that stops matching');
    assert.equal(judgeRule(records, 'value +'), undefined, 'does not compile');
  });

  test('the catalogue finds a prefix one system carries, and the best candidate merges the most', () => {
    const records = [rec(0, 'GB-101'), rec(0, 'GB-102'), rec(0, 'GB-103'), rec(1, '101'), rec(1, '102'), rec(1, '999')];
    const names = catalogueSteps(records).map((s) => s.name);
    assert.deepEqual(names, ['separators:-', 'prefix:GB']);
    const best = bestCandidate(records, deterministicCandidates(records))!;
    assert.deepEqual(best.candidate.steps, ['separators:-', 'prefix:GB']);
    assert.equal(best.judgement.pairs, 2);
  });
});
