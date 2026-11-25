// The ontology's pure core: change classes (spec 25.5), the diff a proposal carries, and
// the manifest hash, which depends on content alone (not on row order or row ids).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classify, contentHash, diff, emptyContent, withEntries, type ObjectTypeEntry } from '../../src/services/ontology/content.service.ts';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const conn = id(900);

const type = (over: Partial<ObjectTypeEntry> = {}): ObjectTypeEntry => ({
  id: id(1), typeVersionId: id(2), apiName: 'supplier', status: 'active', displayName: 'Supplier', pluralName: 'Suppliers', description: null,
  resolutionClass: 'single_source', matchKeys: [], primaryKeyPropertyIdentityId: id(10), titlePropertyIdentityId: id(11),
  defaultTimeFieldPropertyIdentityId: null,
  contributingObjects: [{ connectionId: conn, sourceObject: 'vendors', identifierFieldPath: 'id', connectorVersion: '1' }],
  properties: [
    { identityId: id(10), apiName: 'supplier_id', displayName: 'Id', description: null, dataType: 'string', typeParams: {}, nullable: false,
      isMatchKey: false, sharedPropertyId: null, computedFunctionVersionId: null, status: 'active',
      mappings: [{ connectionId: conn, sourceObject: 'vendors', fieldPath: 'id', valueMap: null, sourceTimeZone: null, confidence: 1, confirmedBy: id(50), confirmedAt: 'a' }] },
    { identityId: id(11), apiName: 'name', displayName: 'Name', description: null, dataType: 'string', typeParams: {}, nullable: true,
      isMatchKey: false, sharedPropertyId: null, computedFunctionVersionId: null, status: 'active',
      mappings: [{ connectionId: conn, sourceObject: 'vendors', fieldPath: 'name', valueMap: null, sourceTimeZone: null, confidence: 1, confirmedBy: id(50), confirmedAt: 'a' }] },
  ],
  timeFields: [], implements: [], visual: {},
  ...over,
});

describe('change classes (spec 25.5)', () => {
  test('new is additive; names and visuals compatible; types, removals and keys breaking', () => {
    assert.equal(classify('object_type', undefined, type()).changeClass, 'additive');
    assert.equal(classify('object_type', type(), type({ displayName: 'Vendor', visual: { icon: 'truck' } })).changeClass, 'compatible');
    const [, name] = type().properties;
    assert.equal(classify('object_type', type(), type({ properties: [type().properties[0]!, { ...name!, dataType: 'integer' }] })).changeClass, 'breaking');
    assert.deepEqual(classify('object_type', type(), type({ properties: [type().properties[0]!] })).notes, ['property_removed']);
    const added = classify('object_type', type(), type({ properties: [...type().properties, { ...name!, identityId: id(12), apiName: 'city' }] }));
    assert.deepEqual([added.changeClass, added.notes], ['additive', ['property_added']]);
    assert.equal(classify('object_type', type(), type({ defaultTimeFieldPropertyIdentityId: id(11) })).changeClass, 'compatible',
      'a default time field where none was set');
    assert.equal(classify('object_type', type({ defaultTimeFieldPropertyIdentityId: id(11) }), type({ defaultTimeFieldPropertyIdentityId: id(12) })).changeClass,
      'breaking', 'changing the default time field');
  });

  test('links: a route added is additive, removed breaking; a first default route compatible', () => {
    const route = { id: id(30), position: 0, connectionId: conn, sourceObject: 'invoices', foreignKeyField: 'vendor_id', referencedField: 'id',
      junctionObject: null, origin: 'declared_fk' as const };
    const link = { id: id(20), apiName: 'supplier_invoices', status: 'active' as const, forwardName: 'issues', reverseName: 'issued by',
      fromTypeId: id(1), toTypeId: id(3), cardinality: 'one_to_many' as const, routes: [route], defaultRouteId: null };
    const second = { ...route, id: id(31), position: 1, connectionId: id(901) };
    assert.equal(classify('link_type', link, { ...link, routes: [route, second] }).changeClass, 'additive');
    assert.equal(classify('link_type', { ...link, routes: [route, second] }, link).changeClass, 'breaking');
    assert.equal(classify('link_type', link, { ...link, defaultRouteId: route.id }).changeClass, 'compatible');
    assert.equal(classify('link_type', link, { ...link, cardinality: 'one_to_one' }).changeClass, 'breaking');
  });

  test('a shared property changing type breaks; an interface gaining a requirement breaks; a new function version is additive', () => {
    const shared = { id: id(40), apiName: 'status', status: 'active' as const, displayName: 'Status', description: null, dataType: 'enum' as const, typeParams: {} };
    assert.equal(classify('shared_property', shared, { ...shared, dataType: 'string' }).changeClass, 'breaking');
    const iface = { id: id(41), apiName: 'has_status', status: 'active' as const, displayName: 'Has status', description: null,
      requiredSharedPropertyIds: [], requiredLinkTypeNames: [] };
    assert.equal(classify('interface', iface, { ...iface, requiredSharedPropertyIds: [id(40)] }).changeClass, 'breaking');
    const version = { id: id(43), version: 1, expression: 'true', inputs: { objectTypeIds: [], propertyIdentityIds: [], linkTypeIds: [], parameters: {} },
      outputType: { dataType: 'boolean' as const, typeParams: {} }, costLimit: 10 };
    const fn = { id: id(42), apiName: 'ok', status: 'active' as const, kind: 'validation' as const, description: null, version };
    assert.equal(classify('function', fn, { ...fn, version: { ...version, id: id(44), version: 2 } }).changeClass, 'additive');
  });
});

describe('diff and hash', () => {
  test('the diff ignores row order, row ids and confirmations; the hash depends on content alone', () => {
    const a = withEntries(emptyContent(), [{ kind: 'object_type', entry: type() }]);
    const reordered = type({ typeVersionId: id(99), properties: [...type().properties].reverse().map((p) => ({
      ...p, mappings: p.mappings.map((m) => ({ ...m, confirmedAt: 'b', confirmedBy: id(51) })),
    })) });
    const b = withEntries(emptyContent(), [{ kind: 'object_type', entry: reordered }]);
    assert.deepEqual(diff(a, b), []);
    const sameRow = withEntries(emptyContent(), [{ kind: 'object_type', entry: { ...reordered, typeVersionId: id(2) } }]);
    assert.ok(contentHash(a).equals(contentHash(sameRow)), 'order and confirmations do not move the hash');
    assert.ok(!contentHash(a).equals(contentHash(withEntries(a, [{ kind: 'object_type', entry: type({ displayName: 'Vendor' }) }]))));
    assert.deepEqual(diff(emptyContent(), a).map((c) => [c.operation, c.changeClass]), [['create', 'additive']]);
  });
});
