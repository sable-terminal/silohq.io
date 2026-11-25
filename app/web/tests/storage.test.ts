// Siloes, Files and the dashboard in a real browser (Part X, spec 41, 37.6; W11, W12), on the
// recognition cell. Siloes turned on with what that keeps stated; a Capture Silo created with
// a required retention and told to keep the history of suppliers' ratings; its wipe previewed
// with what would stop working, then not requested. Files says plainly that uploading needs an
// Import Silo. A favourited saved view is a tile that runs again on open and says when it ran.
// Results as chapter 31 says: a saved view in Prose, View and Data, the person's choice kept; a
// grouped answer drawn as its archetype with the others that fit offered, a bar selected and
// followed to its objects, overridden, and found again in Data. A media set is made over an Import Silo, filled with an image, a video and a voice note (a CSV
// refused), and its image drawn and its video's length and frame shown (D237); a link rule then
// links a photo named by a supplier's registration to that supplier, whose page shows it (D238). No
// script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { saveObjectSet } from '../../server/src/contracts/ontology/objectSet.contract.ts';
import { compilePlan } from '../../server/src/contracts/compile/compile.contract.ts';
import { favouriteView, saveView } from '../../server/src/contracts/workspace/view.contract.ts';
import { service as compileService } from '../../server/src/routes/compile/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createSiloesImportService } from '../../server/src/routes/siloes-import/index.route.ts';
import { createFilesService } from '../../server/src/routes/files/index.route.ts';
import { createImportSilo } from '../../server/src/contracts/siloes/import.contract.ts';
import { createMemoryStore } from '../../server/tests/services/memoryStore.helper.ts';
import { decodablePng, mp4, wav } from '../../server/tests/services/media.helper.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { service as canvasLayoutService } from '../../server/src/routes/canvas-layout/index.route.ts';
import { LOCAL } from '../../server/tests/infra/services.helper.ts';
import { startRecognitionCell, type RecognitionCell } from '../../server/tests/services/recognition.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

/** A memory store that signs no reads. */
const unsigned = () => { const { signRead: _never, ...store } = createMemoryStore(); return store; };

let r: RecognitionCell;
let browser: Browser;
let origin: string;
let page: Page;
let viewId: string;
let regionsViewId: string;
let supplierType: string;
let orderType: string;
let regionProp: string;
const problems: string[] = [];

describe('Siloes, Files and the dashboard in a browser', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    r = await startRecognitionCell([
      { definition: compileService, name: 'compile' },
      { definition: createSiloesCaptureService({ schedule: false }), name: 'siloes-capture', env: { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' } },
      // Import Siloes and Files, for a media set (D237): in memory, Import Siloes first, which Files calls.
      {
        // Storage that signs no reads (as S3 here): an item opens in the reply, shown from a blob.
        definition: createSiloesImportService({ store: unsigned(), schedule: false }), name: 'siloes-import',
        env: { OBJECT_STORE: 's3', OBJECT_BUCKET_SILOES: 'silo-test-siloes', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' },
      },
      { definition: createFilesService({ store: createMemoryStore() }), name: 'files', env: { OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' } },
      { definition: createWorkspaceService(), name: 'workspace' },
      { definition: canvasLayoutService, name: 'canvas-layout', env: { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` } },
      { definition: createGatewayService(), name: 'gateway', env: gateway.env },
    ]);
    // A saved view of north suppliers, favourited onto the dashboard.
    const region = r.prop('supplier', 'region');
    const set = await r.gateway.call(saveObjectSet, {
      body: { name: 'North suppliers', definition: { kind: 'filter', base: { objectTypeId: r.type('supplier').id }, predicate: { cel: 'object.region == "north"', properties: [region] } } },
    }, r.keyed(r.root));
    const view = await r.gateway.call(saveView, { body: { kind: 'object_set', name: 'North suppliers', objectSetId: set.id } }, r.keyed(r.root));
    viewId = view.id;
    supplierType = r.type('supplier').id;
    orderType = r.type('order').id;
    regionProp = region;
    // Suppliers counted by region: a structured plan, kept, and saved as a view of its result.
    const plan = await r.gateway.call(compilePlan, { body: { execute: false, plan: {
      schemaVersion: '1', ontologyVersionId: r.manifest.version.id, nodes: [{ objectTypeId: r.type('supplier').id, filters: [] }], hops: [], select: [], sort: [],
      aggregate: { groupBy: [{ node: 0, property: region }], measures: [{ fn: 'count', node: 0, as: 'suppliers' }] },
    } } }, r.cell.as(r.root));
    if (plan.outcome === 'refusal') throw new Error(plan.refusal.reason);
    regionsViewId = (await r.gateway.call(saveView, { body: { kind: 'result', name: 'Suppliers by region', manifestId: plan.planId } }, r.keyed(r.root))).id;
    await r.gateway.call(favouriteView, { params: { viewId: view.id }, body: { grid: [1, 1, 6, 4] } }, r.cell.as(r.root));

    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/siloes/overview/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/siloes/overview/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  after(async () => {
    await browser?.close();
    await r?.close();
  });

  const toast = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();

  test('Siloes turned on, saying what that keeps; a Capture Silo keeps suppliers\' ratings; a purge previewed with what stops working', async () => {
    await page.getByRole('button', { name: 'Turn Siloes on' }).click();
    await page.getByRole('button', { name: 'New Silo' }).click();
    const create = page.getByRole('dialog', { name: 'New Silo' });
    await create.getByLabel('Name', { exact: true }).fill('Supplier history');
    await create.getByLabel('What it is for').fill('How ratings change over time');
    await create.getByRole('button', { name: 'Make the Silo' }).click();
    await page.waitForURL(/\/siloes\/capture\/\?silo=/);
    const siloId = new URL(page.url()).searchParams.get('silo')!;
    await page.getByRole('button', { name: 'Add a type' }).click();
    const add = page.getByRole('dialog', { name: 'Add a type' });
    await add.getByLabel('Type', { exact: true }).selectOption({ label: 'Suppliers' });
    await add.getByLabel('Rating', { exact: true }).check();
    await add.getByRole('button', { name: 'Keep their history' }).click();
    await toast('Added: its changes are kept from now on').waitFor();
    await page.getByRole('table', { name: 'Types kept' }).getByRole('row').filter({ hasText: /Suppliers\s*Rating/ }).waitFor();

    await page.goto(`${origin}/siloes/overview/`);
    const card = page.getByRole('list', { name: 'Siloes' }).getByRole('listitem').filter({ hasText: 'Supplier history' });
    assert.match(await card.innerText(), /Capture[\s\S]*Kept 365 days/);
    await page.goto(`${origin}/siloes/overview/?silo=${siloId}`);
    await page.getByRole('button', { name: 'Purge…' }).click();
    const purge = page.getByRole('dialog', { name: 'Purge from Supplier history' });
    await purge.getByRole('button', { name: 'Preview the purge' }).click();
    await purge.getByText('What stops working').waitFor();
    await purge.getByRole('button', { name: 'Keep it' }).click();
    await shot(page, 'siloes');
    assert.deepEqual(problems, []);
  });

  test('Files says plainly that uploading needs an Import Silo', async () => {
    await page.goto(`${origin}/files/`);
    await page.waitForURL(/\/files\/all\//);
    await page.getByRole('button', { name: 'Upload' }).first().click();
    await page.getByRole('dialog', { name: 'Upload a file' }).getByText('Uploading needs an Import Silo. An administrator makes one under Siloes.').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(problems, []);
  });

  test('the dashboard: a favourited view is a tile, run again on open, saying when it ran', async () => {
    await page.goto(`${origin}/ask/?mode=dashboard`);
    const tile = page.getByRole('region', { name: 'North suppliers' });
    await tile.getByText(/^Ran (just now|\d)/).waitFor();
    // Names and regions only: Table is its archetype, and the tile is large enough for it.
    await tile.getByRole('row').nth(4).waitFor();
    assert.ok(await tile.getByRole('row').count() >= 5, 'its rows: a header and the four north suppliers');
    assert.deepEqual(problems, []);
  });

  test('a saved view in prose, as a view and as data, from one result; the choice kept for the person (spec 31.2)', async () => {
    await page.goto(`${origin}/ask/views/?view=${viewId}`);
    const tabs = page.getByRole('tablist', { name: 'North suppliers: representation' });
    await tabs.waitFor();
    // Four rows of names and regions: no structure but rows, so Table, and Prose by default.
    assert.equal(await tabs.getByRole('tab', { name: 'Prose' }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tabpanel').getByText(/^4 suppliers match\.$/).waitFor();
    await tabs.getByRole('tab', { name: 'Data' }).click();
    assert.ok(await page.getByRole('tabpanel').getByRole('row').count() >= 5, 'a header and the four north suppliers');
    await page.reload();
    await page.getByRole('tablist', { name: 'North suppliers: representation' }).getByRole('tab', { name: 'Data', selected: true }).waitFor();
    assert.deepEqual(problems, []);
  });

  test('a grouped answer as its archetype, a ranking, the others that fit offered; a bar followed to its objects and found again in Data (spec 31.4, 31.5)', async () => {
    await page.goto(`${origin}/ask/views/?view=${regionsViewId}`);
    const tabs = page.getByRole('tablist', { name: 'Suppliers by region: representation' });
    await tabs.getByRole('tab', { name: 'View', selected: true }).waitFor();
    const showAs = page.getByLabel('Show as');
    assert.equal(await showAs.inputValue(), 'ranking', 'one count over groups: Ranking precedes Composition');
    assert.deepEqual(await showAs.locator('option').allInnerTexts(), ['Ranking (chosen for this shape)', 'Composition', 'Table']);
    await page.getByRole('button', { name: /^north: 4$/ }).click();
    await page.getByRole('region', { name: 'Selected' }).getByRole('link', { name: 'Open the objects behind it' }).waitFor();
    await showAs.selectOption('composition');
    await page.getByRole('button', { name: /^north: 4, \d/ }).waitFor();
    await tabs.getByRole('tab', { name: 'Data' }).click();
    await page.getByRole('tabpanel').locator('tr[aria-selected="true"]').filter({ hasText: 'north' }).waitFor();
    await tabs.getByRole('tab', { name: 'Prose' }).click();
    await page.getByRole('tabpanel').getByText(/^Objects by region: highest north \(4\)/).waitFor();
    assert.deepEqual(problems, []);
  });

  test('an analysis built step by step (spec 37.8): north suppliers, their orders, units by supplier, the orders behind one; saved as a view; a step over its bound refused, naming it', async () => {
    const start = `${origin}/explorer/analyses/?type=${supplierType}&f=${encodeURIComponent(JSON.stringify([{ property: regionProp, op: 'eq', value: 'north' }]))}`;
    await page.goto(start);
    const steps = page.getByRole('list', { name: 'Steps' });
    const step = (n: number) => steps.getByRole('listitem', { name: `Step ${n}` });
    await step(1).getByText(/whose region is north$/).waitFor();
    await page.getByRole('button', { name: 'Add a step' }).click();
    await page.getByRole('menuitem', { name: 'Follow a link' }).click();
    await page.getByRole('button', { name: 'Add a step' }).click();
    await page.getByRole('menuitem', { name: 'Group' }).click();
    await step(3).getByLabel('By').selectOption({ label: 'supplier_id' });
    await step(3).getByLabel('Measure').selectOption('sum');
    await step(3).getByLabel('Of').selectOption({ label: 'Units' });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await step(2).getByText(/^3 orders match\.$/).waitFor();
    // Units by supplier: a ranking; the bar for s01 followed back to its orders.
    await step(3).getByRole('button', { name: /^s01: 7$/ }).click();
    await step(3).getByRole('button', { name: 'Continue with the objects behind it' }).click();
    await step(4).getByText(/^The orders behind supplier_id s01 in step 3$/).waitFor();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await step(4).getByText(/^2 orders match\.$/).waitFor();

    await page.getByRole('button', { name: 'Save as a view' }).click();
    const saving = page.getByRole('dialog', { name: 'Save as a view' });
    await saving.getByLabel('Name').fill('North orders');
    await saving.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/\/ask\/views\/\?view=/);
    await page.getByRole('link', { name: 'Open in Analysis' }).waitFor();
    await page.getByText(/^2 orders match\.$/).waitFor();

    // Bounded at two members, the first step is refused, naming itself, its bound and its count; nothing after it runs.
    await page.goto(start);
    await step(1).getByLabel('At most, members').fill('2');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await step(1).getByText(/^step 1 \(filter\) has 4 members, over its bound of 2/).waitFor();
    assert.deepEqual(problems, []);
  });

  test('an analysis begun from an object view\'s link group: the order, then its deliveries (spec 37.8)', async () => {
    // Order o1, as the CRM knows it, named exactly by its id: two deliveries.
    await page.goto(`${origin}/explorer/object/?type=${orderType}&connection=${r.crm}&ref=o1`);
    const links = page.getByRole('region', { name: 'Links' });
    await links.getByRole('listitem').filter({ hasText: /^order_deliveries/ }).getByRole('link', { name: 'Analyse these' }).click();
    await page.waitForURL(/\/explorer\/analyses\/\?/);
    const steps = page.getByRole('list', { name: 'Steps' });
    await steps.getByRole('listitem', { name: 'Step 2' }).waitFor();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await steps.getByRole('listitem', { name: 'Step 1' }).getByText(/^1 order matches\.$/).waitFor();
    await steps.getByRole('listitem', { name: 'Step 2' }).getByText(/^2 deliverys? match\.$/).waitFor();
    assert.deepEqual(problems, []);
  });

  test('a media set (D237): made over an Import Silo, filled (a CSV refused), its image drawn and its video\'s length and frame shown', async () => {
    await r.gateway.call(createImportSilo, { body: { name: 'Inspections', purpose: 'Site photographs and recordings', retentionDays: 365 } }, r.keyed(r.root));
    await page.goto(`${origin}/files/media/`);
    await page.getByRole('button', { name: 'New media set' }).first().click();
    const made = page.getByRole('dialog', { name: 'New media set' });
    await made.getByLabel('Name', { exact: true }).fill('Pump inspections');
    await made.getByLabel('Kept in').selectOption({ label: 'Inspections' });
    await made.getByRole('button', { name: 'Make the set' }).click();
    await page.waitForURL(/\/files\/media\/\?mediaSet=/);

    await page.getByRole('button', { name: 'Add items' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add items' });
    await add.getByLabel('Files to add').setInputFiles([
      { name: 'diagram.png', mimeType: 'image/png', buffer: decodablePng(64, 48) },
      { name: 'walkround.mp4', mimeType: 'video/mp4', buffer: mp4({ seconds: 95, tracks: [{ handler: 'vide', width: 1920, height: 1080 }] }) },
      { name: 'voice-note.wav', mimeType: 'audio/wav', buffer: wav(3) },
      { name: 'readings.csv', mimeType: 'text/csv', buffer: Buffer.from('id,reading\n1,42\n') },
    ]);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await add.getByText(/that is not an image, video, audio file or PDF a media set keeps/i).waitFor();
    await add.getByRole('button', { name: 'Done' }).click();
    const grid = page.getByRole('list', { name: 'Items' });
    await grid.getByRole('button', { name: 'diagram.png, image' }).waitFor();
    assert.equal(await grid.getByRole('listitem').count(), 3);
    // The thumbnail is the image itself, read as it scrolls into view.
    await page.waitForFunction(() => [...document.querySelectorAll('ul[aria-label="Items"] img')].some((i) => (i as HTMLImageElement).naturalWidth === 64));

    await grid.getByRole('button', { name: 'walkround.mp4, video' }).click();
    const item = page.getByRole('dialog', { name: 'walkround.mp4' });
    await item.getByText('1920 × 1080 pixels').waitFor();
    await item.getByText('1:35').waitFor();
    await page.keyboard.press('Escape');
    await grid.getByRole('button', { name: 'diagram.png, image' }).click();
    await page.waitForFunction(() => (document.querySelector('dialog[open] img') as HTMLImageElement | null)?.naturalWidth === 64);
    await shot(page, 'media-set');
    await page.keyboard.press('Escape');
    assert.deepEqual(problems, []);
  });

  test('a link rule (D238): a photo named by a supplier\'s registration is linked to that supplier, whose page shows it', async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Link rule' }).click();
    const rule = page.getByRole('dialog', { name: 'Link rule' });
    await rule.getByLabel('Objects').selectOption({ label: 'Suppliers' });
    await rule.getByLabel('Whose').selectOption({ label: 'Registration' });
    await rule.getByLabel('Matches the key in names like').fill('site-{key}.png');
    await rule.getByRole('button', { name: 'Save the rule' }).click();
    await toast('Saved: items added from now on are linked by it').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add items' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add items' });
    await add.getByLabel('Files to add').setInputFiles([{ name: 'site-R07.png', mimeType: 'image/png', buffer: decodablePng(32, 24, [200, 120, 40]) }]);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await add.getByText('site-R07.png: added').waitFor();
    await add.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('list', { name: 'Items' }).getByRole('button', { name: 'site-R07.png, image' }).click();
    const linked = page.getByRole('dialog', { name: 'site-R07.png' }).getByRole('list', { name: 'Linked to' });
    await linked.getByText('by the set\'s rule').waitFor();
    await linked.getByRole('link').click();
    await page.waitForURL(/\/explorer\/object\//);
    await page.getByRole('heading', { name: 'Golf' }).first().waitFor();
    const onPage = page.getByRole('list', { name: 'Linked media' });
    await onPage.getByRole('button', { name: 'site-R07.png, from Pump inspections' }).waitFor();
    // Thumbnails are read as they come into view: the section is below the object's facts.
    await onPage.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('ul[aria-label="Linked media"] img')].some((i) => (i as HTMLImageElement).naturalWidth === 32));
    await shot(page, 'object-media');
    assert.deepEqual(problems, []);
  });
});
