// The object view's read (spec 34.2, 34.3) on the recognition cell: suppliers merged from crm
// and erp (five names disagree), orders, deliveries and notes in crm, and 80 events against a
// bound of 50 rows a step.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readObjectView, type ObjectView } from '../../src/contracts/executor/objectView.contract.ts';
import { applyMarking, createFieldPolicy, createMarking, grantClearance, retireFieldPolicy } from '../../src/contracts/policy/governance.contract.ts';
import { declareFieldAuthority, revokeFieldAuthority } from '../../src/contracts/resolution/authority.contract.ts';
import { uuidv7, inTx } from '../db/harness.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;

before(async () => {
  r = await startRecognitionCell([]);
});

after(async () => {
  await r?.close();
});

const open = async (objectTypeId: string, object: { objectId: string } | { connectionId: string; reference: string }, who = r.root) =>
  r.gateway.call(readObjectView, { body: { objectTypeId, object } }, r.cell.as(who));

const viewOf = async (...args: Parameters<typeof open>): Promise<ObjectView> => {
  const out = await open(...args);
  assert.equal(out.outcome, 'object', JSON.stringify(out));
  return (out as { view: ObjectView }).view;
};

const property = (view: ObjectView, apiName: string) => view.properties.find((p) => p.apiName === apiName)!;
const link = (view: ObjectView, name: string) => view.links.find((l) => l.name === name)!;

describe('the object view (spec 34.2, 34.3)', () => {
  let acme: ObjectView;

  test('by a record\'s reference: each system\'s own value, a disagreement with both values and their systems, how the records are bound', async () => {
    acme = await viewOf(r.type('supplier').id, { connectionId: r.crm, reference: 's01' });
    assert.equal(acme.objectTypeId, r.type('supplier').id);
    assert.equal(acme.typeVersionId, r.type('supplier').typeVersionId);
    assert.deepEqual(acme.references.map((x) => [x.connectionId, x.sourceObject, x.reference]).sort(),
      [[r.crm, 'suppliers', 's01'], [r.erp, 'vendors', 'V01']].sort());
    assert.deepEqual(acme.binding, { kind: 'match_key', keys: [{ identityId: r.prop('supplier', 'registration'), apiName: 'registration', normalisation: 'value.trim()' }] });
    assert.equal(acme.unmatched, false);

    const name = property(acme, 'name');
    assert.deepEqual([name.state, name.value, name.from], ['disputed', null, null], 'never resolved by recency or averaged');
    assert.deepEqual(name.readings.map((x) => [x.connectionId, x.fieldPath, x.value]).sort(),
      [[r.crm, 'name', 'Acme Ltd'], [r.erp, 'vendor_name', 'Acme Ltd (erp)']].sort(), 'both values, each with its system');
    assert.ok(name.readings.every((x) => x.connectorVersion.length > 0 && !Number.isNaN(Date.parse(x.readAt)) && x.extraction === null));
    assert.equal(acme.title, null, 'the title is the name, which is disputed');

    const registration = property(acme, 'registration');
    assert.deepEqual([registration.state, registration.value, registration.from], ['agreed', 'R01', null]);
    const rating = property(acme, 'rating');
    assert.deepEqual([rating.state, rating.value, rating.from, rating.readings.length], ['only', 10, r.crm, 1]);
    assert.ok(acme.properties.every((p) => !p.partial && p.authority === null && !p.computed));
    assert.deepEqual(acme.properties.map((p) => p.apiName), ['name', 'email', 'rating', 'region', 'registration'], 'the title first, then as declared');
    assert.deepEqual([acme.withheld, acme.markings, acme.incomplete, acme.actions], [[], [], [], []], 'no Action type targets suppliers');
  });

  test('its links by type and direction, with counts and the first objects by title', async () => {
    const orders = link(acme, 'supplier_orders');
    assert.deepEqual([orders.direction, orders.otherTypeId, orders.count, orders.refusal], ['forward', r.type('order').id, 2, null]);
    assert.deepEqual(orders.objects.map((o) => o.title).sort(), ['o1', 'o2']);
    assert.deepEqual(orders.objects[0]!.references.map((x) => x.connectionId), [r.crm]);

    const o1 = await viewOf(r.type('order').id, { connectionId: r.crm, reference: 'o1' });
    assert.deepEqual([o1.title, o1.binding.kind], ['o1', 'identifier']);
    assert.deepEqual(o1.links.map((l) => [l.name, l.direction, l.count]),
      [['order_deliveries', 'forward', 2], ['order_notes', 'forward', 1], ['supplier_orders of', 'reverse', 1]]);
    assert.equal(link(o1, 'supplier_orders of').objects[0]!.id, acme.id, 'the merged supplier, by the entity graph');
  });

  test('by Silo id alone the same object is found among the type\'s population; nothing there is not found', async () => {
    const again = await viewOf(r.type('supplier').id, { objectId: acme.id });
    assert.equal(again.id, acme.id);
    assert.deepEqual(property(again, 'name').readings.map((x) => x.value).sort(), ['Acme Ltd', 'Acme Ltd (erp)']);
    assert.equal((await viewOf(r.type('supplier').id, { connectionId: r.erp, reference: 'V01' })).id, acme.id, 'by the other system\'s record too');

    assert.deepEqual(await open(r.type('supplier').id, { objectId: uuidv7() }), { outcome: 'not_found' });
    assert.deepEqual(await open(r.type('order').id, { connectionId: r.crm, reference: 'o99' }), { outcome: 'not_found' });
    assert.deepEqual(await open(r.type('order').id, { connectionId: r.erp, reference: 'o1' }), { outcome: 'not_found' }, 'a system the type is not read from');
    assert.deepEqual(await open(uuidv7(), { connectionId: r.crm, reference: 'o1' }), { outcome: 'not_found' }, 'a type that is not there, or not the reader\'s');
  });

  test('a type over the bounds is refused, saying which, never shown from part of it', async () => {
    const byId = await open(r.type('event').id, { objectId: uuidv7() });
    assert.equal(byId.outcome, 'refusal');
    assert.equal((byId as { refusal: { code: string } }).refusal.code, 'query.bound_rows_per_source');
    // The events resource cannot be asked by identifier, so even a reference reads past the bound.
    const byReference = await open(r.type('event').id, { connectionId: r.crm, reference: 'e5' });
    assert.equal((byReference as { refusal: { code: string } }).refusal.code, 'query.bound_rows_per_source');
  });

  test('a system not answering: the answering one is shown, the properties it holds partial; a link through it says why, the others are shown', async () => {
    r.failing.add('/v1/vendors');
    try {
      const partial = await viewOf(r.type('supplier').id, { connectionId: r.crm, reference: 's02' });
      assert.deepEqual(partial.incomplete.map((x) => [x.connectionId, x.sourceObject]), [[r.erp, 'vendors']]);
      assert.match(partial.incomplete[0]!.reason, /not answering/);
      assert.deepEqual(partial.properties.map((p) => [p.apiName, p.partial]),
        [['name', true], ['email', false], ['rating', false], ['region', false], ['registration', true]]);
      // crm's name alone cannot be trusted while erp might disagree (23.5): unchecked, its reading shown.
      const name = property(partial, 'name');
      assert.deepEqual([name.state, name.value, name.readings.map((x) => [x.connectionId, x.value])], ['unchecked', null, [[r.crm, 'Brill plc']]]);
      assert.equal(link(partial, 'supplier_orders').count, 1, 'its links still followed');
      // Opened by the record in the system not answering, there is nothing to show.
      const down = await open(r.type('supplier').id, { connectionId: r.erp, reference: 'V02' });
      assert.equal((down as { refusal: { code: string } }).refusal.code, 'query.source_unavailable');
    } finally {
      r.failing.delete('/v1/vendors');
    }
    r.failing.add('/v1/deliveries');
    try {
      const o1 = await viewOf(r.type('order').id, { connectionId: r.crm, reference: 'o1' });
      const deliveries = link(o1, 'order_deliveries');
      assert.deepEqual([deliveries.count, deliveries.objects, deliveries.refusal?.code], [null, [], 'query.source_unavailable']);
      assert.equal(link(o1, 'order_notes').count, 1);
    } finally {
      r.failing.delete('/v1/deliveries');
    }
  });

  test('a field authority decides a disagreement: the winning system\'s value, named with the declaration, who made it and why (23.4)', async () => {
    const authority = await r.gateway.call(declareFieldAuthority, {
      body: { objectTypeId: r.type('supplier').id, propertyIdentityId: r.prop('supplier', 'name'), winningConnectionId: r.erp, reason: 'the ledger holds trading names' },
    }, r.keyed(r.root));
    try {
      const view = await viewOf(r.type('supplier').id, { connectionId: r.crm, reference: 's01' });
      const name = property(view, 'name');
      assert.deepEqual([name.state, name.value, name.from], ['declared', 'Acme Ltd (erp)', r.erp]);
      assert.deepEqual(name.authority, {
        id: authority.id, winningConnectionId: r.erp, condition: null, reason: 'the ledger holds trading names',
        declaredBy: r.root.membershipId, declaredAt: authority.declaredAt,
      });
      assert.equal(name.readings.length, 2, 'both systems\' values still shown');
      assert.equal(view.title, 'Acme Ltd (erp)');
    } finally {
      await r.gateway.call(revokeFieldAuthority, { params: { authorityId: authority.id } }, r.cell.as(r.root));
    }
  });

  test('field policies and markings: a denied property is named as withheld, a masked one shows its last characters, one whose marking the reader lacks is omitted; the banner names the markings', async () => {
    const policies = [
      await r.gateway.call(createFieldPolicy, { body: { target: { propertyId: r.prop('supplier', 'email') }, effect: 'deny' } }, r.cell.as(r.root)),
      await r.gateway.call(createFieldPolicy, { body: { target: { propertyId: r.prop('supplier', 'name') }, effect: 'mask' } }, r.cell.as(r.root)),
    ];
    const hidden = await r.gateway.call(createMarking, { body: { name: 'Territory', kind: 'compartment' } }, r.cell.as(r.root));
    await r.gateway.call(applyMarking, { body: { markingId: hidden.id, resource: { type: 'property', id: r.prop('supplier', 'region') } } }, r.cell.as(r.root));
    const held = await r.gateway.call(createMarking, { body: { name: 'Commercial', kind: 'compartment' } }, r.cell.as(r.root));
    await r.gateway.call(grantClearance, { body: { markingId: held.id, holder: { kind: 'membership', id: r.root.membershipId } } }, r.cell.as(r.root));
    await r.gateway.call(applyMarking, { body: { markingId: held.id, resource: { type: 'property', id: r.prop('supplier', 'registration') } } }, r.cell.as(r.root));
    try {
      const view = await viewOf(r.type('supplier').id, { connectionId: r.crm, reference: 's11' });
      assert.deepEqual(view.withheld.map((p) => p.apiName), ['email'], 'not visible to you');
      assert.deepEqual(view.properties.map((p) => p.apiName), ['name', 'rating', 'registration'], 'region is omitted without statement');
      const name = property(view, 'name');
      assert.deepEqual([name.effect, name.value, name.readings.map((x) => x.value), view.title], ['mask', '****', ['****', '****'], '****'],
        'a masked value and each masked reading show at most their last four characters');
      assert.deepEqual(view.markings.map((m) => [m.name, m.kind]), [['Commercial', 'compartment']]);

      const { rows } = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
        `select payload->'detail' as detail, payload->'actor' as actor from platform.outbox
          where organisation_id = $1 and event = 'audit_event' and payload->>'event' = 'object_view_opened'`, [r.cell.org]));
      const opened = rows.map((x) => x.detail as Record<string, unknown>);
      assert.ok(opened.some((d) => d['object_id'] === view.id && d['withheld'] === 1 && d['object_type_id'] === r.type('supplier').id));
      assert.ok(rows.every((x) => (x.actor as { membershipId?: string }).membershipId === r.root.membershipId), 'the reader');
      assert.ok(!JSON.stringify(rows).includes('Kilo'), 'references and counts, never a value');
    } finally {
      for (const p of policies) await r.gateway.call(retireFieldPolicy, { params: { fieldPolicyId: p.id } }, r.cell.as(r.root));
    }
  });
});
