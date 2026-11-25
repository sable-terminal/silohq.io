// Media linked to objects (D238): a set's rule (a filename template with one {key}) links each
// item added to the objects whose property holds its key, as whoever adds it may read them; the
// rule applied later links what is already there, never twice; a person links and unlinks an item
// on an object's page; an object lists the items linked to it to those who may see their set.
// Real processes: the files cell with Import Siloes, over the CRM's invoices.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { runPlan } from '../../src/contracts/executor/result.contract.ts';
import {
  addMediaItem, applyMediaLinkRule, createMediaSet, linkMediaItem, listObjectMedia, setMediaLinkRule, shareMediaSet, unlinkMediaItem,
} from '../../src/contracts/files/media.contract.ts';
import { createImportSilo } from '../../src/contracts/siloes/import.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { templateOf, keyOf } from '../../src/services/files/mediaLinks.service.ts';
import { png } from './media.helper.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let mediaSetId: string;
let invoices: string;
const objectOf = new Map<string, string>();
const add = (name: string) => f.gateway.call(addMediaItem, { params: { mediaSetId }, body: { name, contentBase64: png(8, 8).toString('base64') } }, f.keyed(f.root));
const onObject = (who = f.root, key = 'i1') => f.gateway.call(listObjectMedia, { query: { objectTypeId: invoices, objectId: objectOf.get(key)! } }, f.cell.as(who));

before(async () => {
  f = await createFilesCell({ siloes: true });
  await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [f.cell.org]));
  const siloId = (await f.gateway.call(createImportSilo, { body: { name: 'Scans', purpose: 'Scanned invoices', retentionDays: 365 } }, f.keyed(f.root))).id;
  mediaSetId = (await f.gateway.call(createMediaSet, { body: { name: 'Invoice scans', siloId } }, f.keyed(f.root))).id;
  invoices = invoiceType(f.manifest);
  // Each invoice's Silo object id, as root reads them.
  const out = await f.cell.client('workspace').call(runPlan, {
    body: {
      plan: { schemaVersion: '1', ontologyVersionId: f.manifest.version.id, nodes: [{ objectTypeId: invoices, filters: [] }], hops: [], select: [{ node: 0, property: f.prop('invoice_id') }], sort: [] },
      parameters: {}, trigger: 'structured', useCache: false,
    },
  }, f.cell.as(f.root));
  assert.equal(out.outcome, 'answer');
  if (out.outcome === 'answer') for (const o of out.result.page.objects) objectOf.set(String(o.values['invoice_id']), o.id);
});

after(async () => {
  await f?.close();
});

describe('media linked to objects (D238)', () => {
  test('a template, not an expression: one {key}, literal text escaped, * any run', () => {
    const t = templateOf('invoice-{key}*.png');
    assert.equal(keyOf(t, 'invoice-i1 front.png'), 'i1 front', 'the longest key that lets the rest match');
    assert.equal(keyOf(templateOf('invoice-{key} *.png'), 'Invoice-i1 front.PNG'), 'i1', 'case does not matter to the template');
    assert.equal(keyOf(templateOf('a.{key}'), 'abx'), undefined, 'a dot is a dot');
    assert.equal(keyOf(t, 'site.png'), undefined);
    // The worst a filename can do to a template: two * after the key, over a 255-character name that never matches.
    const started = performance.now();
    assert.equal(keyOf(templateOf('x{key}*a*a.png'), `x${'a'.repeat(250)}.jpg`), undefined);
    assert.ok(performance.now() - started < 1_000, 'never slow');
  });

  test('a rule names a type and a text, number or choice property the ontology has', async () => {
    await assert.rejects(f.gateway.call(setMediaLinkRule, { params: { mediaSetId }, body: { rule: { objectTypeId: invoices, propertyId: uuidv7(), pattern: 'invoice-{key}.png' } } }, f.cell.as(f.root)),
      { code: 'files.link_rule_unknown' });
    await assert.rejects(f.gateway.call(setMediaLinkRule, { params: { mediaSetId }, body: { rule: { objectTypeId: invoices, propertyId: f.prop('invoice_id'), pattern: 'invoice.png' } } }, f.cell.as(f.root)));
    const set = await f.gateway.call(setMediaLinkRule, { params: { mediaSetId }, body: { rule: { objectTypeId: invoices, propertyId: f.prop('invoice_id'), pattern: 'invoice-{key} *.png' } } }, f.cell.as(f.root));
    assert.equal(set.linkRule?.pattern, 'invoice-{key} *.png');
  });

  test('an item added is linked by the rule to the object its key names; a key naming nothing, or no key, links nothing', async () => {
    const front = await add('invoice-i1 front.png');
    assert.deepEqual(front.links.map((l) => [l.objectTypeId, l.objectId, l.madeBy]), [[invoices, objectOf.get('i1'), 'rule']]);
    assert.deepEqual((await add('invoice-zz back.png')).links, []);
    assert.deepEqual((await add('site.png')).links, []);
    assert.deepEqual((await onObject()).items.map((i) => [i.name, i.mediaSetName]), [['invoice-i1 front.png', 'Invoice scans']]);
  });

  test('a person links an item on the object\'s page and unlinks it', async () => {
    const site = await add('site plan.png');
    const link = await f.gateway.call(linkMediaItem, { params: { mediaSetId, itemId: site.id }, body: { objectTypeId: invoices, objectId: objectOf.get('i1')! } }, f.cell.as(f.root));
    assert.equal(link.madeBy, 'person');
    assert.deepEqual((await onObject()).items.map((i) => i.name), ['site plan.png', 'invoice-i1 front.png']);
    const again = await f.gateway.call(linkMediaItem, { params: { mediaSetId, itemId: site.id }, body: { objectTypeId: invoices, objectId: objectOf.get('i1')! } }, f.cell.as(f.root));
    assert.equal(again.id, link.id, 'linked once');
    await f.gateway.call(unlinkMediaItem, { params: { mediaSetId, itemId: site.id, linkId: link.id } }, f.cell.as(f.root));
    assert.deepEqual((await onObject()).items.map((i) => i.name), ['invoice-i1 front.png']);
  });

  test('the rule applied later links what is already there, never twice', async () => {
    await f.gateway.call(setMediaLinkRule, { params: { mediaSetId }, body: { rule: null } }, f.cell.as(f.root));
    assert.deepEqual((await add('invoice-i3 front.png')).links, [], 'no rule, no link');
    await f.gateway.call(setMediaLinkRule, { params: { mediaSetId }, body: { rule: { objectTypeId: invoices, propertyId: f.prop('invoice_id'), pattern: 'invoice-{key} *.png' } } }, f.cell.as(f.root));
    const applied = await f.gateway.call(applyMediaLinkRule, { params: { mediaSetId } }, f.cell.as(f.root));
    assert.deepEqual(applied, { items: 5, keyed: 3, linked: 1, refused: null });
    assert.deepEqual((await onObject(f.root, 'i3')).items.map((i) => i.name), ['invoice-i3 front.png']);
    assert.equal((await f.gateway.call(applyMediaLinkRule, { params: { mediaSetId } }, f.cell.as(f.root))).linked, 0);
  });

  test('an object lists its items only to those who may see their set; a viewer may not link', async () => {
    assert.deepEqual((await onObject(f.member)).items, []);
    await f.gateway.call(shareMediaSet, { params: { mediaSetId }, body: { grantee: { membershipId: f.member.membershipId }, access: 'view' } }, f.cell.as(f.root));
    const theirs = (await onObject(f.member)).items;
    assert.deepEqual(theirs.map((i) => i.name), ['invoice-i1 front.png']);
    await assert.rejects(f.gateway.call(linkMediaItem, { params: { mediaSetId, itemId: theirs[0]!.id }, body: { objectTypeId: invoices, objectId: objectOf.get('i3')! } }, f.cell.as(f.member)),
      { code: 'files.media_set_view_only' });
    const events = (await f.cell.migrate.query(`select distinct payload->>'event' as e from platform.outbox where payload->>'event' in
      ('media_link_rule_set', 'media_links_applied', 'media_item_linked', 'media_item_unlinked')`)).rows.map((r) => r.e).sort();
    assert.deepEqual(events, ['media_item_linked', 'media_item_unlinked', 'media_link_rule_set', 'media_links_applied']);
  });
});
