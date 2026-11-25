// The Clone Canvas in a real browser (spec 29, 30; W13), on a live cell: a CRM whose contacts
// stream through a signed webhook, a contact type laid out by stage, and a canvas over a saved set.
// Opened, the set subscribes live and draws in WebGL as a schematic, every fitting layout offered
// with the list as the floor; a member without a stage is counted as not placed, with why. The list
// holds the same set, a clone selected opens its object view, and a provider's webhook reaches the
// change rail. The keyboard moves the selection; several are selected by Shift or by state, named,
// with those not placed stated. Located, the contacts lay out on a map over the cell's own vector
// tiles, drawn through the gateway with their attribution (D227). Anchored to a model imported into
// a Silo, they stand on its parts in 3D, the model in quiet neutrals under their glyphs (D228). No
// script or style is blocked anywhere.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { setCloneLayout } from '../../server/src/contracts/canvas-layout/layout.contract.ts';
import { saveCanvasView } from '../../server/src/contracts/canvas-layout/canvasView.contract.ts';
import { enableStream } from '../../server/src/contracts/change-stream/stream.contract.ts';
import { downloadFile } from '../../server/src/contracts/files/file.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../server/src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../server/src/contracts/connect-registry/connector.contract.ts';
import { putObjectType } from '../../server/src/contracts/ontology/element.contract.ts';
import { saveObjectSet } from '../../server/src/contracts/ontology/objectSet.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../server/src/contracts/ontology/proposal.contract.ts';
import { createCanvasLayoutService } from '../../server/src/routes/canvas-layout/index.route.ts';
import { registerAssetModel, setSpatialAnchor } from '../../server/src/contracts/canvas-layout/spatial.contract.ts';
import { createImportSilo, createSource, uploadFile } from '../../server/src/contracts/siloes/import.contract.ts';
import { createSiloesImportService } from '../../server/src/routes/siloes-import/index.route.ts';
import { spheresGlb } from '../../server/tests/services/gltf.helper.ts';
import { freePort } from '../../server/tests/services/writeback.helper.ts';
import { createChangeStreamService } from '../../server/src/routes/change-stream/index.route.ts';
import { service as compileService } from '../../server/src/routes/compile/index.route.ts';
import { createConnectRuntimeService } from '../../server/src/routes/connect-runtime/index.route.ts';
import { createFilesService } from '../../server/src/routes/files/index.route.ts';
import { createGatewayService } from '../../server/src/routes/gateway/index.route.ts';
import { service as ontologyService } from '../../server/src/routes/ontology/index.route.ts';
import { createActionsService } from '../../server/src/routes/actions/index.route.ts';
import { service as executorService } from '../../server/src/routes/executor/index.route.ts';
import { service as plannerService } from '../../server/src/routes/planner/index.route.ts';
import { service as pushdownService } from '../../server/src/routes/pushdown-compiler/index.route.ts';
import { service as resolutionService } from '../../server/src/routes/resolution/index.route.ts';
import { createSiloesCaptureService } from '../../server/src/routes/siloes-capture/index.route.ts';
import { createStatePlaneService } from '../../server/src/routes/state-plane/index.route.ts';
import { createWorkspaceService } from '../../server/src/routes/workspace/index.route.ts';
import { inTx, uuidv7 } from '../../server/tests/db/harness.helper.ts';
import { LOCAL } from '../../server/tests/infra/services.helper.ts';
import { createConnectCell, type ConnectCell } from '../../server/tests/services/connect.helper.ts';
import { createMemoryStore } from '../../server/tests/services/memoryStore.helper.ts';
import { pmtilesArchive, vectorTile } from '../../server/tests/services/pmtiles.helper.ts';
import { objectKey } from '../../server/src/infra/objectStorage.infra.ts';
import { markSubscribable } from '../../server/tests/services/subscribable.helper.ts';
import { buildExport, gatewayAt, launch, open, shot, signIn, skip } from './browser.helper.ts';

let cell: ConnectCell;
let api: Server;
let browser: Browser;
let origin: string;
let page: Page;
let hookPath: string;
let hookSecret: string;
let locate: () => Promise<unknown>;
let contactTypeId: string;
const store = createMemoryStore();
const problems: string[] = [];
const rows = new Map<string, Record<string, unknown>>([
  ['c1', { id: 'c1', email: 'ada@example.com', score: 15, stage: 'lead', location: '51.5072,-0.1276' }],
  ['c2', { id: 'c2', email: 'grace@example.com', score: 20, stage: 'customer', location: '53.4808,-2.2426' }],
  ['c3', { id: 'c3', email: 'alan@example.com', score: 30, stage: null, location: '55.9533,-3.1883' }],
]);

async function deliver(events: unknown[]): Promise<number> {
  const body = JSON.stringify({ events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', hookSecret).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(`${origin}${hookPath}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature } });
  await res.text();
  return res.status;
}

describe('the Clone Canvas in a browser (spec 29)', { skip }, () => {
  before(async () => {
    await buildExport();
    const gateway = await gatewayAt();
    origin = gateway.origin;
    api = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer tok_valid') { res.writeHead(401, { 'content-type': 'application/json' }).end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [...rows.values()] }));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

    cell = await createConnectCell();
    const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
    await cell.start(ontologyService, 'ontology', 'test_app');
    await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
    await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
    // The object panel's read and the links' plan.
    await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
    await cell.start(resolutionService, 'resolution', 'test_app');
    await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
    await cell.start(plannerService, 'planner', 'test_app');
    await cell.start(executorService, 'executor', 'test_app');
    await cell.start(compileService, 'compile', 'test_app');
    // Files before the canvas service, which files its exports there (29.10).
    // The cell's base map: land over the whole world, and water over its middle, where the contacts are.
    await store.put('tiles', objectKey.basemap('basemaps/test.pmtiles'),
      pmtilesArchive(vectorTile([{ name: 'earth', squares: [[0, 0, 4096, 4096]] }, { name: 'water', squares: [[1024, 1024, 3072, 3072]] }])), 'application/octet-stream');
    // Siloes, for a model imported into one (29.5), in the same store the canvas service reads it from.
    const storage = { OBJECT_STORE: 's3', OBJECT_BUCKET_SILOES: 'silo-test-siloes', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' };
    await cell.start(createSiloesImportService({ store, schedule: false }), 'siloes-import', 'test_app',
      { ...storage, SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02', HTTP_PORT: String(await freePort()) });
    await cell.start(createFilesService({ store }), 'files', 'test_app', {
      OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', OBJECT_BUCKET_TILES: 'silo-test-tiles', MAP_TILES_KEY: 'basemaps/test.pmtiles', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
      HTTP_MAX_BODY_BYTES: String(8 * 1024 * 1024),
    });
    // Capture before the canvas service, which reads the past from it (30.8).
    await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app', { SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02' });
    // The canvas service after the executor and Files it calls; the state plane after it, for its rules.
    await cell.start(createCanvasLayoutService({ store }), 'canvas-layout', 'test_app', { ...live, ...storage });
    await cell.start(createStatePlaneService({ watchMs: 300, coalesceAbovePerSecond: 10 }), 'state-plane', 'test_app', live);
    await cell.start(createWorkspaceService(), 'workspace', 'test_app');
    await cell.start(createGatewayService({ coalesceMs: 0 }), 'gateway', 'test_app', { ...gateway.env, ...live, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64') });
    const gw = cell.client('gateway');
    const root = await cell.signIn('root@acme.example');
    const editor = await cell.member('editor@acme.example', 'Super admin');
    const keyed = (who: typeof root) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

    const connector = await gw.call(createConnector, { body: { slug: 'crm', name: 'CRM', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
    await gw.call(createManifestVersion, {
      params: { connectorId: connector.id },
      body: {
        document: {
          schemaVersion: '1', identity: { name: 'Example CRM', provider: 'Example', version: '1.0.0' },
          transport: { viaAgent: false, baseUrl: apiUrl }, protocol: { kind: 'rest' },
          auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
          objects: [{
            name: 'contacts', identifier: ['id'],
            fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'email', type: 'string' }, { name: 'score', type: 'integer' }, { name: 'stage', type: 'string' }, { name: 'location', type: 'string' }],
            source: { kind: 'rest', request: { method: 'GET', path: '/v1/contacts', query: {} }, records: { jsonata: 'results' } },
          }],
          changeStream: {
            webhook: {
              verify: { cel: '{"expected": hex(hmac_sha256(secret.webhook, headers["x-timestamp"] + "." + body)), "provided": headers["x-signature"], "signedAt": int(headers["x-timestamp"])}' },
              decode: { jsonata: '[events.{"object": "contacts", "entityRef": id, "operation": type, "changed": data, "sourceSeq": seq}]' },
            },
            objects: [{ object: 'contacts', sources: [{ kind: 'webhook' }], ordering: 'source_sequence' }],
          },
        } as never,
      },
    }, keyed(root));
    let connection = await gw.call(createConnection, { body: { connectorId: connector.id, name: 'CRM', owningScopeId: cell.scopes['engineering']! } }, keyed(root));
    await gw.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gw.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    const enabled = await gw.call(enableStream, { params: { connectionId: connection.id }, body: {} }, cell.as(root));
    hookPath = enabled.webhook!.path;
    hookSecret = enabled.webhook!.secret!;
    await markSubscribable(cell, connection.id, ['contacts']);

    const branch = await gw.call(openBranch, { body: { name: 'contacts' } }, keyed(editor));
    const mapped = (apiName: string, field: string, dataType: 'string' | 'integer' | 'geopoint') => ({ apiName, displayName: apiName, dataType, mappings: [{ connectionId: connection.id, sourceObject: 'contacts', fieldPath: field }] });
    const put = await gw.call(putObjectType, {
      params: { branchId: branch.id, apiName: 'contact' },
      body: {
        displayName: 'Contact', pluralName: 'Contacts', contributingObjects: [{ connectionId: connection.id, sourceObject: 'contacts', identifierFieldPath: 'id' }],
        properties: [mapped('contact_id', 'id', 'string'), mapped('email', 'email', 'string'), mapped('score', 'score', 'integer'), mapped('stage', 'stage', 'string'), mapped('location', 'location', 'geopoint')],
        primaryKey: 'contact_id', title: 'email',
      },
    }, keyed(editor));
    const proposal = await gw.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Contacts' } }, keyed(editor));
    await gw.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await gw.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    const prop = (apiName: string) => put.element.properties.find((p) => p.apiName === apiName)!.identityId;
    contactTypeId = put.element.id;
    await gw.call(setCloneLayout, { params: { objectTypeId: put.element.id }, body: { labelPropertyId: prop('email'), stagePropertyId: prop('stage') } }, cell.as(root));
    locate = () => gw.call(setCloneLayout, {
      params: { objectTypeId: put.element.id }, body: { labelPropertyId: prop('email'), stagePropertyId: prop('stage'), geoPropertyId: prop('location'), crs: 'EPSG:4326' },
    }, cell.as(root));
    const set = await gw.call(saveObjectSet, {
      body: { name: 'Engaged contacts', definition: { kind: 'filter', base: { objectTypeId: put.element.id }, predicate: { cel: 'object.score > 10', properties: [prop('score')] } } },
    }, keyed(root));
    await gw.call(saveCanvasView, { body: { canvasScope: 'set', objectSetId: set.id, name: 'Pipeline', layoutKind: 'schematic' } }, keyed(root));

    browser = await launch();
    page = await open(browser, problems);
    await page.goto(`${origin}/clones/canvas/`);
    await page.waitForURL(/\/sign-in\//);
    await signIn(page, 'root@acme.example');
    await page.waitForURL(`${origin}/clones/canvas/`);
  });

  beforeEach(() => {
    problems.length = 0;
  });

  /** The canvas view's saved layout and camera, as its row holds them. */
  const savedCamera = async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select layout_kind, camera from clone.canvas_views where name = 'Pipeline'`))).rows[0] as {
    layout_kind: string; camera: { centre?: number[]; zoom?: number; position?: number[]; target?: number[] };
  };

  after(async () => {
    await browser?.close();
    await cell?.close();
    await new Promise((resolve) => api?.close(resolve));
  });

  test('opened live and drawn in WebGL as a schematic; every fitting layout offered, the list the floor; one without a stage not placed, with why', async () => {
    await page.getByRole('table', { name: 'Canvases' }).getByRole('link', { name: 'Pipeline' }).click();
    await page.waitForURL(/\/clones\/canvas\/\?view=/);
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    await canvas.getByText(/^Live/).waitFor();
    await page.getByText('(3 contacts)').waitFor();
    const layouts = canvas.getByRole('group', { name: 'Layout' });
    assert.deepEqual(await layouts.getByRole('button').allInnerTexts(), ['Schematic', 'List']);
    assert.equal(await layouts.getByRole('button', { name: 'Schematic' }).getAttribute('aria-pressed'), 'true');
    await canvas.getByRole('img', { name: /^Canvas of 3 clones/ }).locator('canvas').waitFor();
    await canvas.getByText('Laying out…').waitFor({ state: 'detached' });
    const tray = canvas.getByRole('complementary', { name: 'Layers and filters' });
    await tray.getByText('1 object lacks what this layout needs.').waitFor();
    await tray.getByText('it has no stage').waitFor();
    await shot(page, 'canvas-schematic');
    assert.deepEqual(problems, []);
  });

  test('the list holds the same set; a clone selected opens its object view; a webhook reaches the change rail', async () => {
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    await canvas.getByRole('button', { name: 'View as list' }).click();
    const list = canvas.getByRole('table', { name: '3 clones' });
    await list.waitFor();
    await list.getByRole('button', { name: 'ada@example.com' }).click();
    const panel = canvas.getByRole('complementary', { name: 'Selected object' });
    await panel.getByRole('table', { name: 'Properties' }).waitFor();
    assert.equal(await deliver([{ id: 'c1', type: 'update', seq: 1, data: { score: 16 } }]), 202);
    const rail = canvas.getByRole('region', { name: 'Change rail' });
    await rail.getByText(/ada@example.com score → 16/).waitFor({ timeout: 15_000 });
    await shot(page, 'canvas-list');
    assert.deepEqual(problems, []);
  });

  test('by keyboard and in several (29.6, 29.9): arrows move the selection; several selected by Shift or by state, named, with which are not placed; Escape clears', async () => {
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    await canvas.getByRole('button', { name: 'View as canvas' }).click();
    const deck = canvas.getByRole('img', { name: /^Canvas of 3 clones/ });
    await deck.locator('canvas').waitFor();
    await canvas.getByText('Laying out…').waitFor({ state: 'detached' });
    const panel = canvas.getByRole('complementary', { name: 'Selected object' });
    await deck.focus();
    await page.keyboard.press('Escape');
    await panel.getByText(/^Select a clone/).waitFor();
    // Stages as columns, sorted: customer (grace), then lead (ada). With nothing selected, an arrow takes the top-left clone.
    await page.keyboard.press('ArrowRight');
    await panel.locator('strong', { hasText: 'grace@example.com' }).waitFor();
    await page.keyboard.press('ArrowRight');
    await panel.locator('strong', { hasText: 'ada@example.com' }).waitFor();
    await page.keyboard.press('Shift+ArrowLeft');
    await panel.getByText('2 contacts selected').waitFor();
    await page.keyboard.press('Escape');
    await panel.getByText(/^Select a clone/).waitFor();

    const tray = canvas.getByRole('complementary', { name: 'Layers and filters' });
    await tray.getByRole('button', { name: 'Select all unknown' }).click();
    await panel.getByText('3 contacts selected').waitFor();
    await panel.getByText('1 of the selection is not placed by this layout: alan@example.com.').waitFor();
    await panel.getByText('No Action you may see acts on contacts.').waitFor();
    await shot(page, 'canvas-selection');
    assert.deepEqual(problems, []);
  });

  test('saved with its camera (29.6): zoomed, saved, and opened again where it was left', async () => {
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    if (await canvas.getByRole('button', { name: 'View as canvas' }).count() > 0) await canvas.getByRole('button', { name: 'View as canvas' }).click();
    const surface = canvas.getByRole('img', { name: /^Canvas of 3 clones/ });
    await surface.locator('canvas').waitFor();
    await canvas.getByText('Laying out…').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Save the view' }).click();
    await page.getByText('Saved.').first().waitFor();
    const fitted = await savedCamera();
    await surface.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Save the view' }).click();
    let saved = await savedCamera();
    for (let i = 0; i < 50 && saved.camera.zoom === fitted.camera.zoom; i++) { await page.waitForTimeout(100); saved = await savedCamera(); }
    assert.equal(saved.layout_kind, 'schematic');
    assert.ok(saved.camera.centre?.length === 2 && typeof saved.camera.zoom === 'number', JSON.stringify(saved.camera));
    assert.ok(saved.camera.zoom! > fitted.camera.zoom!, `zoomed in from where it was fitted: ${fitted.camera.zoom} to ${saved.camera.zoom}`);

    await page.reload();
    await canvas.getByRole('img', { name: /^Canvas of 3 clones/ }).locator('canvas').waitFor();
    await canvas.getByText('Laying out…').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Save the view' }).click();
    await page.getByText('Saved.').first().waitFor();
    assert.deepEqual((await savedCamera()).camera, saved.camera, 'opened where it was saved, not fitted again');
    assert.deepEqual(problems, []);
  });

  test('exported as a PNG by this browser (29.10; D225): the canvas as shown, stamped, filed as the person\'s own export', async () => {
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    await canvas.getByRole('img', { name: /^Canvas of 3 clones/ }).locator('canvas').waitFor();
    await page.getByRole('button', { name: 'Export as PNG' }).click();
    await page.getByText('Saved to Files as Pipeline.png.').first().waitFor({ timeout: 30_000 });
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select f.content_type, j.status from files.files f join clone.render_jobs j on j.file_id = f.id where f.name = 'Pipeline.png'`));
    assert.deepEqual(rows.map((r) => [r.content_type, r.status]), [['image/png', 'completed']]);
    if (process.env['SCREENSHOTS_DIR'] !== undefined) {
      const { rows: [file] } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(`select id from files.files where name = 'Pipeline.png'`));
      const image = await cell.client('gateway').call(downloadFile, { params: { fileId: file.id } }, cell.as(await cell.signIn('root@acme.example')));
      await writeFile(path.join(process.env['SCREENSHOTS_DIR'], 'canvas-export.png'), Buffer.from(image.content, 'base64'));
    }
    assert.deepEqual(problems, []);
  });

  test('time and scenarios (30.8, 30.9): without Capture the past is not drawn, and the bar says why; with no scenario chosen, nothing is overlaid', async () => {
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    const time = canvas.getByRole('form', { name: 'Time' });
    await time.getByLabel('Show the set at').fill('2026-11-20T09:00');
    await time.getByRole('button', { name: 'Show' }).click();
    await time.getByText(/Siloes are switched off for this organisation, so there is no Capture history/).waitFor();
    assert.equal(await time.getByRole('button', { name: 'Back to live' }).count(), 0, 'nothing past is drawn');
    const overlay = canvas.getByRole('region', { name: 'Scenario overlay' });
    await overlay.getByRole('combobox', { name: 'Scenario overlay' }).waitFor();
    assert.equal(await canvas.getByText(/is overlaid: simulated, not current/).count(), 0);
    assert.deepEqual(problems, []);
  });

  test('on a map (29.3; D227): the cell\'s own vector tiles under the clones, through the gateway, with their attribution; exported with them', async () => {
    await locate();
    const tiles: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/v1/map-tiles/')) tiles.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await page.reload();
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    await canvas.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Map' }).click();
    const deck = canvas.getByRole('img', { name: /^Canvas of 3 clones/ });
    await deck.getByText('© OpenStreetMap contributors').waitFor({ timeout: 20_000 });
    assert.equal(await deck.getByText(/Base map unavailable/).count(), 0);
    await page.waitForFunction(() => document.querySelector('.maplibregl-canvas') !== null);
    // The middle of the map is the tile's water, drawn in the theme's water colour, under the canvas's own drawing.
    await page.waitForFunction(() => {
      const map = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas')!;
      const probe = document.createElement('canvas');
      probe.width = map.width; probe.height = map.height;
      const g = probe.getContext('2d')!;
      g.drawImage(map, 0, 0);
      const [r, gr, b] = g.getImageData(Math.floor(map.width / 2), Math.floor(map.height / 2), 1, 1).data;
      const rgb = (token: string) => { const s = document.createElement('span'); s.style.color = `var(${token})`; document.body.append(s); const m = getComputedStyle(s).color.match(/\d+/g)!.map(Number); s.remove(); return m; };
      const [surface, info] = [rgb('--surface'), rgb('--info')];
      const water = [0, 1, 2].map((i) => Math.round(surface[i]! + (info[i]! - surface[i]!) * 0.22));
      return Math.abs(r! - water[0]!) + Math.abs(gr! - water[1]!) + Math.abs(b! - water[2]!) <= 6;
    }, undefined, { timeout: 20_000 });
    assert.ok(tiles.length > 0 && tiles.every((t) => t === '200 /api/v1/map-tiles/0/0/0'), tiles.join(', '));
    await shot(page, 'canvas-map');
    await page.getByRole('button', { name: 'Export as PNG' }).click();
    await page.getByText('Saved to Files as Pipeline.png.').nth(0).waitFor({ timeout: 30_000 });
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select f.id from files.files f join clone.render_jobs j on j.file_id = f.id where f.name = 'Pipeline.png' and j.status = 'completed' order by f.created_at`));
    assert.equal(rows.length, 2, 'the map exported beside the schematic');
    if (process.env['SCREENSHOTS_DIR'] !== undefined) {
      const image = await cell.client('gateway').call(downloadFile, { params: { fileId: rows[1].id } }, cell.as(await cell.signIn('root@acme.example')));
      await writeFile(path.join(process.env['SCREENSHOTS_DIR'], 'canvas-map-export.png'), Buffer.from(image.content, 'base64'));
    }
    assert.deepEqual(problems, []);
  });

  test('a base map whose tiles cannot be read (29.12): marked unavailable, saying why, and the plain coordinate grid drawn instead', async () => {
    store.objects.clear();
    await page.reload();
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    await canvas.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Map' }).click();
    const deck = canvas.getByRole('img', { name: /^Canvas of 3 clones/ });
    await deck.getByText('Base map unavailable: its tiles could not be read, so objects are drawn on a plain coordinate grid.').waitFor({ timeout: 20_000 });
    assert.equal(await deck.getByText('© OpenStreetMap contributors').count(), 0);
    assert.equal(await page.locator('.maplibregl-canvas').count(), 0, 'the map is removed');
    await shot(page, 'canvas-map-unavailable');
    assert.deepEqual(problems, []);
  });

  test('in 3D (29.5; D228): a model imported into a Silo, the contacts on the parts their anchors name, the model in quiet neutrals under their glyphs; selected by keyboard; exported with it', async () => {
    const gw = cell.client('gateway');
    const root = await cell.signIn('root@acme.example');
    const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [cell.org]));
    const silo = await gw.call(createImportSilo, { body: { name: 'Site', purpose: 'Models of the plant', retentionDays: 365 } }, keyed());
    const source = await gw.call(createSource, { params: { siloId: silo.id }, body: { kind: 'upload' } }, cell.as(root));
    const glb = spheresGlb([{ name: 'Pump1', translation: [-1, 0, 0] }, { name: 'Valve2', translation: [1.5, 0, 0], scale: 0.5 }]);
    const file = await gw.call(uploadFile, { params: { siloId: silo.id, sourceId: source.id }, body: { filename: 'pump-house.glb', contentClass: 'asset_model', contentBase64: glb.toString('base64') } }, keyed());
    const model = await gw.call(registerAssetModel, { body: { siloFileId: file.id, name: 'Pump house' } }, keyed());
    await gw.call(setSpatialAnchor, { body: { assetModelId: model.id, objectTypeId: contactTypeId, matchRule: 'score > 18', modelNodeName: 'Pump1' } }, keyed());
    await gw.call(setSpatialAnchor, { body: { assetModelId: model.id, objectTypeId: contactTypeId, matchRule: 'score <= 18', modelNodeName: 'Valve2' } }, keyed());

    await page.reload();
    const canvas = page.getByRole('article', { name: 'Pipeline' });
    const layouts = canvas.getByRole('group', { name: 'Layout' });
    await layouts.getByRole('button', { name: '3D' }).waitFor();
    assert.equal(await layouts.getByRole('button').first().innerText(), '3D', 'a deliberate customer act first (29.2)');
    await layouts.getByRole('button', { name: '3D' }).click();
    const view = canvas.getByRole('img', { name: /^3D model Pump house with 3 clones/ });
    await view.waitFor();
    await view.getByText(/^(Reading|Drawing) the model/).waitFor({ state: 'detached', timeout: 20_000 });
    assert.equal(await view.getByText(/could not be drawn/).count(), 0);
    const tray = canvas.getByRole('complementary', { name: 'Layers and filters' });
    // Levels of detail (29.5; D249): the coarsest is drawn first, the full model swapped in once read; far off, a coarser one again.
    const level = () => page.evaluate(() => document.querySelector<HTMLCanvasElement>('canvas[data-under="model"]')?.dataset['level']);
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-under="model"]')?.dataset['level'] === '0', undefined, { timeout: 15_000 });
    await view.hover();
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(50); }
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-under="model"]')?.dataset['level'] !== '0', undefined, { timeout: 15_000 });
    assert.ok(['1', '2'].includes((await level())!), 'far off, a coarser level');
    await canvas.getByRole('button', { name: 'Frame all' }).click();
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-under="model"]')?.dataset['level'] === '0', undefined, { timeout: 15_000 });

    // The model drawn neutral: state is told only by the glyphs, never by the model's own red.
    const across = () => page.evaluate(() => {
      const model = document.querySelector<HTMLCanvasElement>('canvas[data-under="model"]')!;
      const probe = document.createElement('canvas');
      probe.width = model.width; probe.height = model.height;
      const g = probe.getContext('2d')!;
      g.drawImage(model, 0, 0);
      const row = g.getImageData(0, Math.floor(model.height / 2), model.width, 1).data;
      const opaque: number[][] = [];
      for (let i = 0; i < row.length; i += 4) if (row[i + 3]! > 250) opaque.push([row[i]!, row[i + 1]!, row[i + 2]!]);
      return opaque;
    });
    await page.waitForFunction(() => document.querySelector('canvas[data-under="model"]') !== null);
    let drawn: number[][] = [];
    for (let i = 0; i < 40 && drawn.length === 0; i++) { drawn = await across(); if (drawn.length === 0) await page.waitForTimeout(250); }
    assert.ok(drawn.length > 20, 'the model is drawn');
    assert.ok(drawn.every(([r, g, b]) => Math.abs(r! - g!) < 16 && Math.abs(g! - b!) < 16), `neutral: ${JSON.stringify(drawn.slice(0, 3))}`);
    await tray.getByLabel("The model's own colours").check();
    await page.waitForFunction(() => {
      const model = document.querySelector<HTMLCanvasElement>('canvas[data-under="model"]')!;
      const probe = document.createElement('canvas');
      probe.width = model.width; probe.height = model.height;
      const g = probe.getContext('2d')!;
      g.drawImage(model, 0, 0);
      const row = g.getImageData(0, Math.floor(model.height / 2), model.width, 1).data;
      for (let i = 0; i < row.length; i += 4) if (row[i + 3]! > 250 && row[i]! > row[i + 1]! + 60) return true;
      return false;
    }, undefined, { timeout: 10_000 });
    await tray.getByLabel("The model's own colours").uncheck();

    // Every contact placed by its anchors; the keyboard moves over what is on screen; the selection framed.
    assert.equal(await tray.getByText(/lacks what this layout needs/).count(), 0);
    const panel = canvas.getByRole('complementary', { name: 'Selected object' });
    await view.focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    await panel.locator('strong', { hasText: /@example\.com/ }).waitFor();
    await canvas.getByRole('button', { name: 'Frame the selection' }).click();
    await shot(page, 'canvas-3d');

    await page.getByRole('button', { name: 'Export as PNG' }).click();
    await page.getByText('Saved to Files as Pipeline.png.').nth(0).waitFor({ timeout: 30_000 });
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select drawn_asset_model_id, status from clone.render_jobs order by requested_at desc limit 1`));
    assert.deepEqual([rows[0].drawn_asset_model_id, rows[0].status], [model.id, 'completed'], 'the image carries what it drew');
    if (process.env['SCREENSHOTS_DIR'] !== undefined) {
      const { rows: [last] } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(`select file_id from clone.render_jobs order by requested_at desc limit 1`));
      const image = await gw.call(downloadFile, { params: { fileId: last.file_id } }, cell.as(root));
      await writeFile(path.join(process.env['SCREENSHOTS_DIR'], 'canvas-3d-export.png'), Buffer.from(image.content, 'base64'));
    }

    // Saved with its camera (29.6): opened again, the model is seen from where it was saved, not framed whole.
    await page.getByRole('button', { name: 'Save the view' }).click();
    await page.getByText('Saved.').first().waitFor();
    const saved = await savedCamera();
    assert.equal(saved.layout_kind, 'spatial_3d');
    assert.ok(saved.camera.position?.length === 3 && saved.camera.target?.length === 3, JSON.stringify(saved.camera));
    await page.reload();
    await view.waitFor();
    await view.getByText(/^(Reading|Drawing) the model/).waitFor({ state: 'detached', timeout: 20_000 });
    await page.getByRole('button', { name: 'Save the view' }).click();
    await page.getByText('Saved.').first().waitFor();
    assert.deepEqual((await savedCamera()).camera, saved.camera, 'the saved camera, not the model framed again');
    assert.deepEqual(problems, []);
  });
});
