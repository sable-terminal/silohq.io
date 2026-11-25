// The pure rules of connector maintenance and discovery: the structure observed from a sample
// (never a value), whether a type fits, the rename-versus-meaning rule, the analysis per
// spec 17.3, the repaired document; and discovery's targets, proposals and promoted manifest.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConformanceTest } from '../../src/contracts/conformance/conformance.contract.ts';
import type { ObservedField } from '../../src/contracts/connect-runtime/observe.contract.ts';
import type { FoundStructure } from '../../src/contracts/discovery/discovery.contract.ts';
import { manifestSchema, type Manifest } from '../../src/contracts/connect/manifest.contract.ts';
import { structureOf } from '../../src/services/connect-runtime/observe.service.ts';
import {
  analyse, consistent, fieldNameFor, fit, inferType, nextVersion, repairedDocument, type ObjectStructure,
} from '../../src/services/connector-maintenance/drift.service.ts';
import { fieldType, inTargets, promotedManifest, proposeStructure, snake } from '../../src/services/discovery/proposals.service.ts';
import { restManifest } from './connect.helper.ts';

const field = (path: string, over: Partial<ObservedField> = {}): ObservedField => ({
  path, present: 10, nulls: 0, kinds: { string: 10, integer: 0, number: 0, boolean: 0, object: 0, array: 0 }, distinct: 10,
  dateLike: 0, dateTimeLike: 0, numericStrings: 0, meanLength: 12, ...over,
});
const ints = (path: string, n = 10) => field(path, { kinds: { string: 0, integer: n, number: 0, boolean: 0, object: 0, array: 0 }, meanLength: null, distinct: 5 });

describe('the observed structure', () => {
  test('paths, kinds and counts; values hashed and dropped', () => {
    const { fields, omittedPaths } = structureOf([
      { id: 'a1', properties: { email: 'x@example.com', score: 3, tags: ['a'] } },
      { id: 'a2', properties: { email: null, score: 2.5 }, 'odd.key': 1 },
    ]);
    assert.equal(omittedPaths, 0);
    const by = new Map(fields.map((f) => [f.path, f]));
    assert.deepEqual([...by.keys()], ['id', 'properties', 'properties.email', 'properties.score', 'properties.tags']);
    assert.equal(by.get('properties.email')!.present, 1);
    assert.equal(by.get('properties.email')!.nulls, 1);
    assert.deepEqual(by.get('properties.score')!.kinds, { string: 0, integer: 1, number: 1, boolean: 0, object: 0, array: 0 });
    assert.equal(by.get('properties.tags')!.kinds.array, 1);
    assert.ok(!JSON.stringify(fields).includes('example.com'), 'no value leaves');
  });
});

describe('fit and inference', () => {
  test('integer widens to number; a string where a number is declared does not fit', () => {
    assert.equal(fit('integer', ints('s')), 'ok');
    assert.equal(fit('integer', field('s', { kinds: { string: 0, integer: 5, number: 5, boolean: 0, object: 0, array: 0 } })), 'widen');
    assert.equal(fit('integer', field('s')), 'incompatible');
    assert.equal(fit('number', field('s', { numericStrings: 10 })), 'ok', 'numeric strings read as numbers');
    assert.equal(fit('date-time', field('s', { dateTimeLike: 10 })), 'ok');
    assert.equal(fit('date-time', field('s', { dateTimeLike: 9 })), 'incompatible');
    assert.equal(fit('string', field('s', { kinds: { string: 0, integer: 0, number: 0, boolean: 0, object: 10, array: 0 } })), 'incompatible');
  });

  test('a new path is declared as what it holds', () => {
    assert.equal(inferType(ints('n')), 'integer');
    assert.equal(inferType(field('d', { dateLike: 10 })), 'date');
    assert.equal(inferType(field('t', { dateTimeLike: 10 })), 'date-time');
    assert.equal(inferType(field('s')), 'string');
    assert.equal(fieldNameFor('properties.phone', new Set(['id'])), 'properties_phone');
    assert.equal(fieldNameFor('2nd', new Set()), 'f_2nd');
    assert.equal(fieldNameFor('id', new Set(['id'])), 'id_2');
  });
});

describe('rename versus meaning (spec 17.3)', () => {
  test('consistent only where presence, distinctness, kind, length and date shape match', () => {
    assert.equal(consistent(field('a'), 10, field('b'), 10), true);
    assert.equal(consistent(field('a'), 10, field('b', { present: 4, nulls: 6 }), 10), false, 'presence');
    assert.equal(consistent(field('a'), 10, field('b', { distinct: 2 }), 10), false, 'distinctness');
    assert.equal(consistent(field('a'), 10, field('b', { meanLength: 30 }), 10), false, 'length');
    assert.equal(consistent(field('a'), 10, ints('b'), 10), false, 'kind');
  });
});

const manifest = (): Manifest => manifestSchema.parse(restManifest({
  baseUrl: 'https://api.example.test',
  objects: [{
    name: 'contacts', identifier: ['id'],
    fields: [{ name: 'id', type: 'string' }, { name: 'email', type: 'string', path: 'p.email' }, { name: 'score', type: 'integer', path: 'p.score' }],
    source: { kind: 'rest', request: { method: 'GET', path: '/c' }, records: { jsonata: 'results' } },
    pushdown: { filters: [{ field: 'email', ops: ['eq', 'contains'], patch: { cel: '{"query": {"e": string(value)}}' } }], sort: [{ field: 'score', patch: { cel: '{"query": {"s": field}}' } }] },
  }],
}));
const observed = (fields: ObservedField[]): ObjectStructure => ({ object: 'contacts', observable: true, reason: null, records: 10, fields });
const baseline = new Map([['contacts', observed([field('id'), field('p'), field('p.email'), ints('p.score')])]]);

describe('the analysis (spec 17.3)', () => {
  test('one consistent new path for an absent field is a rename, auto-applied', () => {
    const a = analyse({ manifest: manifest(), tests: [], gate: { failingOperators: [] }, baseline,
      observations: [observed([field('id'), field('p', { kinds: { string: 0, integer: 0, number: 0, boolean: 0, object: 10, array: 0 } }), field('p.mail'), ints('p.score')])] });
    assert.deepEqual(a.proposals.map((p) => [p.changeKind, p.auto, p.halt]), [['rename', true, false]]);
    assert.deepEqual(a.proposals[0]!.changes, [{ op: 'rename_field', object: 'contacts', field: 'email', fromPath: 'p.email', toPath: 'p.mail' }]);
  });

  test('two candidates, or none consistent, or no baseline, is a change of meaning: a halt', () => {
    const two = analyse({ manifest: manifest(), tests: [], gate: { failingOperators: [] }, baseline,
      observations: [observed([field('id'), field('p.mail'), field('p.mail2'), ints('p.score')])] });
    assert.equal(two.proposals[0]!.changeKind, 'semantic');
    assert.equal(two.proposals[0]!.halt, true);
    const none = analyse({ manifest: manifest(), tests: [], gate: { failingOperators: [] }, baseline: new Map(),
      observations: [observed([field('id'), field('p.mail'), ints('p.score')])] });
    assert.ok(none.drift.some((d) => d.kind === 'meaning_changed' && d.detail.endsWith('no_baseline')));
  });

  test('widened, incompatible, removed, new, and pushdown that returns a different answer', () => {
    const widened = analyse({ manifest: manifest(), tests: [], gate: { failingOperators: [] }, baseline,
      observations: [observed([field('id'), field('p.email'), field('p.score', { kinds: { string: 0, integer: 6, number: 4, boolean: 0, object: 0, array: 0 } })])] });
    assert.deepEqual(widened.proposals.map((p) => [p.changeKind, p.halt, p.auto]), [['type_changed', false, false]]);

    const wrong = analyse({ manifest: manifest(), tests: [], gate: { failingOperators: [] }, baseline,
      observations: [observed([field('id'), field('p.email'), field('p.score')])] });
    assert.deepEqual(wrong.proposals.map((p) => [p.changeKind, p.halt]), [['type_changed', true]]);

    const tests: ConformanceTest[] = [{ id: 'read.list.contacts', class: 'read', object: 'contacts', outcome: 'failed', durationMs: 1, reason: 'error:source.not_found', operator: null }];
    const gone = analyse({ manifest: manifest(), tests, gate: { failingOperators: [{ object: 'contacts', field: 'email', op: 'eq' }] }, baseline, observations: [] });
    assert.deepEqual(gone.proposals.map((p) => p.changeKind), ['object_removed'], 'a gone object loses no pushdown');

    const added = analyse({ manifest: manifest(), tests: [], gate: { failingOperators: [] }, baseline,
      observations: [observed([field('id'), field('p.email'), ints('p.score'), field('p.phone'), field('p.rare', { present: 2, nulls: 0 })])] });
    assert.deepEqual(added.proposals[0]!.changes, [{ op: 'add_field', object: 'contacts', field: 'p_phone', type: 'string', path: 'p.phone' }],
      'a path in under half the sample is not proposed');

    const failed = (field: string, op: string, reason: string): ConformanceTest => ({
      id: `filter_pushdown.${field}.${op}`, class: 'filter_pushdown', object: 'contacts', outcome: 'failed', durationMs: 1, reason, operator: { field, op },
    });
    const lost = analyse({
      manifest: manifest(), baseline, observations: [observed([field('id'), field('p.email'), ints('p.score')])],
      tests: [failed('email', 'eq', 'rows:10/expected:1'), failed('email', 'contains', 'error:source.upstream'), failed('score', 'sort', 'order_differs:rows:10/expected:10')],
      gate: { failingOperators: [{ object: 'contacts', field: 'email', op: 'eq' }, { object: 'contacts', field: 'email', op: 'contains' }, { object: 'contacts', field: 'score', op: 'sort' }] },
    });
    assert.deepEqual(lost.proposals.map((p) => [p.changeKind, p.auto]), [['pushdown_lost', true]]);
    assert.deepEqual(lost.proposals[0]!.changes, [
      { op: 'remove_filter', object: 'contacts', field: 'email', ops: ['eq'] }, { op: 'remove_sort', object: 'contacts', field: 'score' },
    ], 'a source error is not evidence of a filter ignored');
  });
});

describe('the repaired document', () => {
  test('changes applied to a copy, at the next free version, without the old conformance block', () => {
    const doc = { ...JSON.parse(JSON.stringify(manifest())), conformance: { suiteVersion: 'x' } } as Record<string, unknown>;
    const out = repairedDocument(doc, [
      { op: 'rename_field', object: 'contacts', field: 'email', fromPath: 'p.email', toPath: 'p.mail' },
      { op: 'widen_type', object: 'contacts', field: 'score', from: 'integer', to: 'number' },
      { op: 'add_field', object: 'contacts', field: 'p_phone', type: 'string', path: 'p.phone' },
      { op: 'remove_filter', object: 'contacts', field: 'email', ops: ['eq', 'contains'] },
    ], nextVersion('1.0.0', new Set(['1.0.0', '1.0.1'])));
    const parsed = manifestSchema.parse(out);
    assert.equal(parsed.identity.version, '1.0.2');
    assert.equal(parsed.conformance, undefined);
    const fields = parsed.objects[0]!.fields;
    assert.equal(fields.find((f) => f.name === 'email')!.path, 'p.mail');
    assert.equal(fields.find((f) => f.name === 'score')!.type, 'number');
    assert.equal(fields.find((f) => f.name === 'p_phone')!.provenance, 'observed');
    assert.deepEqual(parsed.objects[0]!.pushdown.filters, []);
    assert.equal((doc as { identity: { version: string } }).identity.version, '1.0.0', 'the original is untouched');
  });
});

describe('discovery rules (spec 19)', () => {
  test('a host is inside the explicit targets or it is not', () => {
    const targets = ['10.0.0.0/24', 'db.internal.example'];
    assert.equal(inTargets('10.0.0.17', targets), true);
    assert.equal(inTargets('10.0.1.17', targets), false);
    assert.equal(inTargets('DB.internal.example', targets), true);
    assert.equal(inTargets('other.internal.example', targets), false);
    assert.equal(inTargets('10.0.0.5', ['10.0.0.5']), true);
  });

  const found: FoundStructure = {
    product: 'Example SQL', version: '15', protocol: 'sql', dialect: 'postgres', port: 5432, nodeClasses: [], topics: [],
    schemas: [{
      name: 'sales', tables: [
        { name: 'Customers', rowCount: 120, columns: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'text', nullable: true }],
          primaryKey: ['id'], uniqueKeys: [], foreignKeys: [] },
        { name: 'orders', rowCount: 900, primaryKey: ['id'], uniqueKeys: [],
          columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: 'customer_id', type: 'integer', nullable: false },
            { name: 'total', type: 'numeric(12,2)', nullable: true }, { name: 'placed_at', type: 'timestamp with time zone', nullable: true }],
          foreignKeys: [{ columns: ['customer_id'], targetSchema: 'sales', targetTable: 'Customers', targetColumns: ['id'] }] },
        { name: 'notes', rowCount: null, primaryKey: [], uniqueKeys: [['ref']],
          columns: [{ name: 'ref', type: 'text', nullable: false }, { name: 'customer_id', type: 'integer', nullable: true }], foreignKeys: [] },
      ],
    }],
  };

  test('object types from tables, links from declared keys and, at lower confidence, inferred references', () => {
    const p = proposeStructure(found, undefined);
    assert.deepEqual(p.objectTypes.map((o) => [o.sourceObject, o.apiName, o.identifier.join(',')]),
      [['sales.Customers', 'customer', 'id'], ['sales.orders', 'order', 'id'], ['sales.notes', 'note', 'ref']]);
    assert.deepEqual(p.links.map((l) => [l.from, l.to, l.origin, l.cardinality]), [
      ['sales.orders', 'sales.Customers', 'declared', 'many_to_one'], ['sales.notes', 'sales.Customers', 'inferred', 'many_to_one'],
    ]);
    assert.equal(p.links[1]!.confidence < p.links[0]!.confidence, true);
  });

  test('the promoted manifest is valid, with relationships, and generic over catalogues', () => {
    const p = proposeStructure(found, undefined);
    const doc = promotedManifest(found, p.links, '10.0.0.5')!;
    const parsed = manifestSchema.parse(doc);
    assert.equal(parsed.transport.viaAgent, true);
    assert.deepEqual(parsed.objects.map((o) => o.name), ['customers', 'orders', 'notes']);
    const orders = parsed.objects[1]!;
    assert.deepEqual(orders.fields.map((f) => [f.name, f.type]), [['id', 'integer'], ['customer_id', 'integer'], ['total', 'number'], ['placed_at', 'date-time']]);
    assert.deepEqual(orders.relationships, [{ field: 'customer_id', targetObject: 'customers', targetField: 'id', kind: 'foreign_key' }]);
    assert.equal(parsed.objects[2]!.relationships[0]!.kind, 'reference');
    assert.equal(promotedManifest({ ...found, protocol: 'other', dialect: null }, [], 'h'), undefined);
    assert.equal(fieldType('VARCHAR(20)'), 'string');
    assert.equal(snake('OrderLines'), 'order_lines');
  });
});
