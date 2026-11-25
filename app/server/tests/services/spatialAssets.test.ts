// Spatial plans, 3D asset models and their anchors (spec 29.4, 29.5, 66.4; D208): files
// imported into an Import Silo are registered for the canvas from their own bytes (a plan's
// size from its PNG header; a model checked as a self-contained glTF 2.0 binary, its unlisted
// extensions stripped and named, refused otherwise and recorded); anchors place an object, or
// every object a predicate matches, at plan pixels or on a model node; purging keeps the row,
// removes what was served and ends the anchors. Every step in the audit log.

import { replaySpatialPurges } from '../../src/contracts/platform/purgeLedger.contract.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  listSpatialAssets, placeOnAssetModel, placeOnSpatialPlan, purgeAssetModel, purgeSpatialPlan, readAssetModel, readSpatialPlanImage, registerAssetModel,
  registerSpatialPlan, removeSpatialAnchor, setSpatialAnchor,
} from '../../src/contracts/canvas-layout/spatial.contract.ts';
import { openCanvasView, saveCanvasView } from '../../src/contracts/canvas-layout/canvasView.contract.ts';
import { createImportSilo, createSource, uploadFile } from '../../src/contracts/siloes/import.contract.ts';
import { createCanvasLayoutService } from '../../src/routes/canvas-layout/index.route.ts';
import { createSiloesImportService } from '../../src/routes/siloes-import/index.route.ts';
import { checkGlb, fitGeoreference, rasterSize, readPosition } from '../../src/utils/spatialAsset.util.ts';
import { spheresGlb } from './gltf.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

const store = createMemoryStore();
let wb: WritebackCell;
let siloId = '';
let sourceId = '';

/** A PNG's signature and IHDR: all the plan check reads. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'latin1'); ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); ihdr.writeUInt8(6, 17);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
}

/** A glTF 2.0 binary with a JSON chunk and an empty binary chunk. */
function glb(doc: Record<string, unknown>): Buffer {
  let json = Buffer.from(JSON.stringify(doc), 'utf8');
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const bin = Buffer.alloc(8 + 8);
  bin.writeUInt32LE(8, 0); bin.writeUInt32LE(0x004e4942, 4);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length + bin.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json, bin]);
}

const model = glb({
  asset: { version: '2.0', generator: 'test' }, extensionsUsed: ['KHR_materials_unlit', 'VENDOR_private'],
  nodes: [{ name: 'Pump1', extensions: { VENDOR_private: { secret: true } } }, { name: 'Valve2' }, {}],
  materials: [{ extensions: { KHR_materials_unlit: {} } }], buffers: [{ byteLength: 8 }],
});

const keyed = () => ({ ...wb.cell.as(wb.root), idempotencyKey: uuidv7() });
const upload = async (filename: string, contentClass: 'site_plan' | 'asset_model', bytes: Buffer) => (await wb.gateway.call(uploadFile, {
  params: { siloId, sourceId }, body: { filename, contentClass, contentBase64: bytes.toString('base64') },
}, keyed())).id;
const events = async (name: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
  `select payload->'resource'->>'id' as resource, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by seq`,
  [wb.cell.org, name]))).rows as { resource: string; detail: Record<string, unknown> }[];

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      const storage = { OBJECT_STORE: 's3', OBJECT_BUCKET_SILOES: 'silo-test-siloes', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' };
      await cell.start(createSiloesImportService({ store, schedule: false }), 'siloes-import', 'test_app',
        { ...storage, SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02', HTTP_PORT: String(await freePort()) });
      await cell.start(createCanvasLayoutService({ store }), 'canvas-layout', 'test_app', { ...storage, REDIS_STATE_URL: `${LOCAL.redisUrl}/2` });
    },
  });
  await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [wb.cell.org]));
  siloId = (await wb.gateway.call(createImportSilo, { body: { name: 'Site', purpose: 'Plans and models of the plant', retentionDays: 365 } }, keyed())).id;
  sourceId = (await wb.gateway.call(createSource, { params: { siloId }, body: { kind: 'upload' } }, wb.cell.as(wb.root))).id;
});

after(async () => {
  await wb?.close();
});

describe('reading spatial assets from their bytes (spec 29.4, 29.5)', () => {
  test('a plan\'s size from its PNG header; a model checked, its unlisted extensions stripped and named', () => {
    assert.deepEqual(rasterSize(png(800, 600)), { format: 'png', width: 800, height: 600 });
    assert.equal(rasterSize(Buffer.from('<svg/>')), undefined, 'an SVG is never served as it is');
    const checked = checkGlb(model);
    assert.deepEqual(checked.nodeNames, ['Pump1', 'Valve2']);
    assert.deepEqual([checked.report.extensionsKept, checked.report.extensionsStripped], [['KHR_materials_unlit'], ['VENDOR_private']]);
    assert.ok(!checked.glb.toString('latin1').includes('VENDOR_private'), 'stripped from the served copy');
    assert.equal(checked.glb.readUInt32LE(8), checked.glb.length);
    assert.equal(checkGlb(checked.glb).report.extensionsStripped.length, 0, 'the served copy checks clean');
    for (const [bytes, reason] of [
      [glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8, uri: 'https://example.com/a.bin' }] }), 'external_uri'],
      [glb({ asset: { version: '1.0' } }), 'version'],
      [glb({ asset: { version: '2.0' }, extensionsRequired: ['VENDOR_private'], extensionsUsed: ['VENDOR_private'] }), 'extension_required'],
      [Buffer.from('not a model at all'), 'not_glb'],
    ] as const) {
      assert.throws(() => checkGlb(bytes), (e: { code?: string; details?: { reason?: string } }) => e.code === 'asset_model.rejected' && e.details?.reason === reason, reason);
    }
  });
});

describe('positions on a plan (spec 29.3, 29.4)', () => {
  test('a position in the forms sources give it; a plan\'s affine fit through its control points, and none from points on a line', () => {
    for (const value of [{ lat: 51.5, lon: -0.1 }, { latitude: 51.5, longitude: -0.1 }, { type: 'Point', coordinates: [-0.1, 51.5] }, [-0.1, 51.5], '51.5, -0.1']) {
      assert.deepEqual(readPosition(value), { lat: 51.5, lon: -0.1 }, JSON.stringify(value));
    }
    for (const value of [null, 'here', { lat: 95, lon: 0 }, [1], { x: 1, y: 2 }]) assert.equal(readPosition(value), undefined, JSON.stringify(value));
    const fit = fitGeoreference([{ x: 0, y: 0, lat: 51.5, lon: -0.1 }, { x: 800, y: 0, lat: 51.5, lon: -0.09 }, { x: 0, y: 600, lat: 51.49, lon: -0.1 }, { x: 800, y: 600, lat: 51.49, lon: -0.09 }])!;
    const at = fit({ lat: 51.495, lon: -0.095 });
    assert.ok(Math.abs(at.x - 400) < 1e-6 && Math.abs(at.y - 300) < 1e-6, JSON.stringify(at));
    assert.equal(fitGeoreference([{ x: 0, y: 0, lat: 51.5, lon: -0.1 }, { x: 1, y: 1, lat: 51.6, lon: -0.2 }, { x: 2, y: 2, lat: 51.7, lon: -0.3 }]), undefined);
    assert.equal(fitGeoreference([{ x: 0, y: 0, lat: 51.5, lon: -0.1 }, { x: 1, y: 1, lat: 51.6, lon: -0.2 }]), undefined);
  });
});

describe('spatial plans, models and anchors (spec 29.4, 29.5; D208)', () => {
  let planId = '';
  let modelId = '';
  let modelViewId = '';

  test('registered from imported files by a holder of asset.upload; a rejected model is recorded and nothing kept', async () => {
    const planFile = await upload('ground-floor.png', 'site_plan', png(800, 600));
    const modelFile = await upload('pump-house.glb', 'asset_model', model);
    const badFile = await upload('outside.glb', 'asset_model', glb({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/t.png' }] }));

    await assert.rejects(wb.gateway.call(registerSpatialPlan, { body: { siloFileId: modelFile, name: 'Wrong' } }, keyed()), { code: 'spatial.wrong_content_class' });
    const plan = await wb.gateway.call(registerSpatialPlan, {
      body: { siloFileId: planFile, name: 'Ground floor', controlPoints: [{ x: 0, y: 0, lat: 51.5, lon: -0.1 }, { x: 800, y: 0, lat: 51.5, lon: -0.09 }, { x: 0, y: 600, lat: 51.49, lon: -0.1 }] },
    }, keyed());
    planId = plan.id;
    assert.deepEqual([plan.widthPx, plan.heightPx, plan.controlPoints?.length, plan.siloId], [800, 600, 3, siloId]);

    const registered = await wb.gateway.call(registerAssetModel, { body: { siloFileId: modelFile, name: 'Pump house' } }, keyed());
    modelId = registered.id;
    assert.deepEqual(registered.nodeNames, ['Pump1', 'Valve2']);
    assert.deepEqual(registered.validationReport['extensionsStripped'], ['VENDOR_private']);
    const served = [...store.objects.entries()].find(([k]) => k.includes(`/asset-models/${modelId}`));
    assert.ok(served && !served[1].body.toString('latin1').includes('VENDOR_private'), 'the checked copy is what is served, beside the file');

    await assert.rejects(wb.gateway.call(registerAssetModel, { body: { siloFileId: badFile, name: 'Outside' } }, keyed()),
      (e: { code?: string; details?: { reason?: string } }) => e.code === 'asset_model.rejected' && e.details?.reason === 'external_uri');
    assert.deepEqual((await events('asset_model_rejected')).map((e) => [e.detail['silo_file_id'], e.detail['reason']]), [[badFile, 'external_uri']]);
    assert.deepEqual((await events('spatial_plan_uploaded')).map((e) => [e.resource, e.detail['width_px'], e.detail['georeferenced']]), [[planId, 800, true]]);
    assert.deepEqual((await events('asset_model_uploaded')).map((e) => [e.resource, e.detail['extensions_stripped']]), [[modelId, 'VENDOR_private']]);

    const member = await wb.cell.member('no-assets@acme.example', 'Member');
    await assert.rejects(wb.gateway.call(registerSpatialPlan, { body: { siloFileId: planFile, name: 'Again' } }, { ...wb.cell.as(member), idempotencyKey: uuidv7() }),
      (e: { code?: string }) => e.code === 'clone.not_permitted' || e.code === 'gateway.not_permitted' || e.code === 'policy.denied' || /not_permitted|forbidden/.test(String(e.code)));
  });

  test('anchors: an object at plan pixels, objects a predicate matches on a model node; checked against the plan, the model and the type', async () => {
    const objectRef = uuidv7();
    const onPlan = await wb.gateway.call(setSpatialAnchor, { body: { planId, objectTypeId: wb.contactTypeId, objectRef, planX: 120, planY: 340 } }, keyed());
    assert.deepEqual([onPlan.planX, onPlan.planY, onPlan.objectRef], [120, 340, objectRef]);
    await assert.rejects(wb.gateway.call(setSpatialAnchor, { body: { planId, objectTypeId: wb.contactTypeId, objectRef, planX: 900, planY: 10 } }, keyed()),
      { code: 'spatial.anchor_outside' });
    const onModel = await wb.gateway.call(setSpatialAnchor, { body: { assetModelId: modelId, objectTypeId: wb.contactTypeId, matchRule: 'score > 10', modelNodeName: 'Pump1' } }, keyed());
    assert.equal(onModel.modelNodeName, 'Pump1');
    await assert.rejects(wb.gateway.call(setSpatialAnchor, { body: { assetModelId: modelId, objectTypeId: wb.contactTypeId, objectRef, modelNodeName: 'Boiler' } }, keyed()),
      { code: 'spatial.node_unknown' });
    await assert.rejects(wb.gateway.call(setSpatialAnchor, { body: { assetModelId: modelId, objectTypeId: wb.contactTypeId, matchRule: 'no_such_field > 1', modelNodeName: 'Pump1' } }, keyed()),
      { code: 'expression.invalid' });

    const listed = await wb.gateway.call(listSpatialAssets, { query: {} }, wb.cell.as(wb.root));
    assert.deepEqual([listed.plans.length, listed.models.length, listed.anchors.length, listed.withheld], [1, 1, 2, 0]);

    await wb.gateway.call(removeSpatialAnchor, { params: { anchorId: onPlan.id } }, wb.cell.as(wb.root));
    assert.deepEqual((await events('spatial_anchor_set')).map((e) => e.detail['by']), ['object', 'predicate']);
    assert.deepEqual((await events('spatial_anchor_removed')).map((e) => e.resource), [onPlan.id]);
  });

  test('the canvas reads a plan\'s image, and where its objects stand: their own anchor, then a predicate\'s, then the georeference', async () => {
    const image = await wb.gateway.call(readSpatialPlanImage, { params: { planId } }, wb.cell.as(wb.root));
    assert.deepEqual([image.contentType, image.widthPx, image.heightPx], ['image/png', 800, 600]);
    assert.equal(Buffer.from(image.content, 'base64').toString('latin1', 1, 4), 'PNG');

    const [anchored, matched, located, outside, nowhere] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const own = await wb.gateway.call(setSpatialAnchor, { body: { planId, objectTypeId: wb.contactTypeId, objectRef: anchored, planX: 10, planY: 20 } }, keyed());
    const rule = await wb.gateway.call(setSpatialAnchor, { body: { planId, objectTypeId: wb.contactTypeId, matchRule: 'score > 10', planX: 700, planY: 500 } }, keyed());
    const placed = await wb.gateway.call(placeOnSpatialPlan, {
      params: { planId },
      body: {
        objectTypeId: wb.contactTypeId, positionProperty: 'location', objects: [
          { ref: anchored, values: { score: 50 } },
          { ref: matched, values: { score: 11 } },
          { ref: located, values: { score: 1, location: { lat: 51.495, lon: -0.095 } } },
          { ref: outside, values: { location: [-0.2, 51.6] } },
          { ref: nowhere, values: { score: 1 } },
        ],
      },
    }, wb.cell.as(wb.root));
    const by = Object.fromEntries(placed.placements.map((p) => [p.ref, p]));
    assert.deepEqual([by[anchored]?.by, by[anchored]?.x, by[anchored]?.y, by[anchored]?.anchorId], ['anchor', 10, 20, own.id], 'its own anchor before any predicate');
    assert.deepEqual([by[matched]?.by, by[matched]?.x, by[matched]?.anchorId], ['predicate', 700, rule.id]);
    assert.equal(by[located]?.by, 'georeference');
    assert.ok(Math.abs(by[located]!.x - 400) < 1e-6 && Math.abs(by[located]!.y - 300) < 1e-6);
    assert.deepEqual(placed.notPlaced, [
      { ref: outside, reason: 'its position lies outside the plan' },
      { ref: nowhere, reason: 'no anchor places it, and it has no position Silo can read' },
    ]);
    await assert.rejects(wb.gateway.call(placeOnSpatialPlan, { params: { planId: uuidv7() }, body: { objectTypeId: wb.contactTypeId, objects: [] } }, wb.cell.as(wb.root)),
      { code: 'spatial.target_not_found' });
  });

  test('the 3D view reads a model in parts, and the node each object stands on: its own anchor, then a predicate\'s (29.5; D228)', async () => {
    const served = [...store.objects.entries()].find(([k]) => k.includes(`/asset-models/${modelId}`))![1].body;
    const whole = await wb.gateway.call(readAssetModel, { params: { assetModelId: modelId }, query: {} }, wb.cell.as(wb.root));
    assert.deepEqual([whole.contentType, whole.bytes, whole.offset], ['model/gltf-binary', served.length, 0]);
    assert.ok(Buffer.from(whole.content, 'base64').equals(served), 'the checked copy, as registered');
    const rest = await wb.gateway.call(readAssetModel, { params: { assetModelId: modelId }, query: { offset: 20 } }, wb.cell.as(wb.root));
    assert.ok(Buffer.from(rest.content, 'base64').equals(served.subarray(20)));
    await assert.rejects(wb.gateway.call(readAssetModel, { params: { assetModelId: modelId }, query: { offset: served.length } }, wb.cell.as(wb.root)),
      { code: 'asset_model.offset_out_of_range' });

    const [valve, pump, nowhere] = [uuidv7(), uuidv7(), uuidv7()];
    const own = await wb.gateway.call(setSpatialAnchor, { body: { assetModelId: modelId, objectTypeId: wb.contactTypeId, objectRef: valve, modelNodeName: 'Valve2' } }, keyed());
    const placed = await wb.gateway.call(placeOnAssetModel, {
      params: { assetModelId: modelId },
      body: { objectTypeId: wb.contactTypeId, objects: [{ ref: valve, values: { score: 50 } }, { ref: pump, values: { score: 11 } }, { ref: nowhere, values: { score: 1 } }] },
    }, wb.cell.as(wb.root));
    assert.deepEqual(placed.placements.map((p) => [p.ref, p.node, p.by]), [[valve, 'Valve2', 'anchor'], [pump, 'Pump1', 'predicate']], 'its own anchor before any predicate');
    assert.equal(placed.placements[0]!.anchorId, own.id);
    assert.deepEqual(placed.notPlaced, [{ ref: nowhere, reason: 'no anchor places it on this model' }]);
    await assert.rejects(wb.gateway.call(placeOnAssetModel, { params: { assetModelId: uuidv7() }, body: { objectTypeId: wb.contactTypeId, objects: [] } }, wb.cell.as(wb.root)),
      { code: 'spatial.target_not_found' });

    // A view keeps its model under the 3D layout, and only there.
    await assert.rejects(wb.gateway.call(saveCanvasView, { body: { canvasScope: 'estate_map', name: 'Wrong', layoutKind: 'graph_force', assetModelId: modelId } }, keyed()),
      { code: 'clone.model_needs_3d' });
    const view = await wb.gateway.call(saveCanvasView, { body: { canvasScope: 'estate_map', name: 'Pump house', layoutKind: 'spatial_3d', assetModelId: modelId } }, keyed());
    assert.equal((await wb.gateway.call(openCanvasView, { params: { canvasViewId: view.id } }, wb.cell.as(wb.root))).view.assetModelId, modelId);
    modelViewId = view.id;
  });

  test('compressed where it is not, and simplified to up to three levels at upload, every node kept (29.5; D249)', async () => {
    const file = await upload('valves.glb', 'asset_model', spheresGlb([{ name: 'Pump1', translation: [-1, 0, 0] }, { name: 'Valve2', translation: [1, 0, 0] }]));
    const fine = await wb.gateway.call(registerAssetModel, { body: { siloFileId: file, name: 'Valve gallery' } }, keyed());
    assert.equal(fine.compression, 'meshopt_applied');
    assert.deepEqual(fine.levels.map((l) => [l.level, l.ratio]), [[0, 1], [1, 0.5], [2, 0.15]]);
    assert.ok(fine.levels.every((l, i) => i === 0 || (l.bytes < fine.levels[i - 1]!.bytes && l.triangles < fine.levels[i - 1]!.triangles)), JSON.stringify(fine.levels));
    assert.equal(Number(fine.bytes), fine.levels[0]!.bytes);
    for (const level of fine.levels) {
      let bytes = Buffer.alloc(0);
      for (let offset = 0; offset < level.bytes;) {
        const part = await wb.gateway.call(readAssetModel, { params: { assetModelId: fine.id }, query: { offset, level: level.level } }, wb.cell.as(wb.root));
        assert.deepEqual([part.level, part.bytes], [level.level, level.bytes]);
        bytes = Buffer.concat([bytes, Buffer.from(part.content, 'base64')]);
        offset = bytes.length;
      }
      const read = checkGlb(bytes);
      assert.deepEqual(read.nodeNames, ['Pump1', 'Valve2'], 'anchors name nodes: every level keeps them');
      assert.deepEqual(read.report.extensionsKept, ['EXT_meshopt_compression', 'KHR_mesh_quantization'], 'compressed, its quantised attributes declared');
    }
    await assert.rejects(wb.gateway.call(readAssetModel, { params: { assetModelId: fine.id }, query: { level: 2, offset: 0 } }, wb.cell.as(wb.root))
      .then(() => wb.gateway.call(readAssetModel, { params: { assetModelId: modelId }, query: { level: 1 } }, wb.cell.as(wb.root))), { code: 'asset_model.level_unavailable' },
    'a model with nothing to simplify has one level');
    assert.deepEqual((await events('asset_model_uploaded')).at(-1)!.detail['levels'], 3);
    // Purged, every level goes.
    await wb.gateway.call(purgeAssetModel, { params: { assetModelId: fine.id } }, wb.cell.as(wb.root));
    assert.ok(![...store.objects.keys()].some((k) => k.includes(`/asset-models/${fine.id}`)), 'every level is gone');
    // The purge ledger (8.2; D251): a restore that brings the model back has it purged again.
    const { rows: [ledger] } = await wb.cell.migrate.query(
      `select id, organisation_id, created_at, correlation_id, payload from platform.outbox where topic = 'platform.purge_ledger' and payload->>'assetModelId' = $1`, [fine.id]);
    assert.deepEqual(ledger.payload, { kind: 'spatial', assetModelId: fine.id });
    await wb.cell.migrate.query('update clone.asset_models set purged_at = null where id = $1', [fine.id]);
    const replayed = await wb.cell.client('maintenance').call(replaySpatialPurges, { body: { entries: [{
      id: ledger.id, organisationId: ledger.organisation_id, occurredAt: new Date(ledger.created_at).toISOString(), correlationId: ledger.correlation_id, entry: ledger.payload,
    }] } }, { correlationId: uuidv7() });
    assert.deepEqual(replayed, { replayed: 1, skipped: 0 });
    assert.notEqual((await wb.cell.migrate.query('select purged_at from clone.asset_models where id = $1', [fine.id])).rows[0].purged_at, null, 'purged again');
  });

  test('purging a model keeps its row as the record, removes the served copy and ends its anchors; a plan likewise', async () => {
    const purged = await wb.gateway.call(purgeAssetModel, { params: { assetModelId: modelId } }, wb.cell.as(wb.root));
    assert.ok(purged.purgedAt);
    assert.ok(![...store.objects.keys()].some((k) => k.includes(`/asset-models/${modelId}`)), 'the served copy is gone');
    assert.deepEqual((await events('asset_model_purged')).filter((e) => e.resource === modelId).map((e) => [e.resource, e.detail['anchors_ended'], e.detail['reason']]),
      [[modelId, 2, 'requested']]);
    // Purged, the next layout stands instead, with the reason (29.12); nothing of it is read.
    const reopened3d = await wb.gateway.call(openCanvasView, { params: { canvasViewId: modelViewId } }, wb.cell.as(wb.root));
    assert.deepEqual([reopened3d.view.assetModelId, reopened3d.statement], [null, 'The 3D model was purged, so the next layout is shown instead.']);
    await assert.rejects(wb.gateway.call(readAssetModel, { params: { assetModelId: modelId }, query: {} }, wb.cell.as(wb.root)), { code: 'spatial.purged' });
    await assert.rejects(wb.gateway.call(setSpatialAnchor, { body: { assetModelId: modelId, objectTypeId: wb.contactTypeId, objectRef: uuidv7(), modelNodeName: 'Pump1' } }, keyed()),
      { code: 'spatial.purged' });
    // A view keeps its site plan under the map layout, and only there.
    await assert.rejects(wb.gateway.call(saveCanvasView, { body: { canvasScope: 'estate_map', name: 'Wrong', layoutKind: 'graph_force', planId } }, keyed()),
      { code: 'clone.plan_needs_map' });
    const view = await wb.gateway.call(saveCanvasView, { body: { canvasScope: 'estate_map', name: 'Ground floor', layoutKind: 'spatial_map', planId } }, keyed());
    assert.equal(view.planId, planId);
    assert.equal((await wb.gateway.call(openCanvasView, { params: { canvasViewId: view.id } }, wb.cell.as(wb.root))).view.planId, planId);
    const plan = await wb.gateway.call(purgeSpatialPlan, { params: { planId } }, wb.cell.as(wb.root));
    // Purged, the map stands instead, with the reason (32.8).
    const reopened = await wb.gateway.call(openCanvasView, { params: { canvasViewId: view.id } }, wb.cell.as(wb.root));
    assert.deepEqual([reopened.view.planId, reopened.statement], [null, 'The site plan was purged, so the map is shown instead.']);
    assert.ok(plan.purgedAt);
    assert.deepEqual((await events('spatial_plan_purged')).map((e) => e.resource), [planId]);
    await assert.rejects(wb.gateway.call(readSpatialPlanImage, { params: { planId } }, wb.cell.as(wb.root)), { code: 'spatial.purged' });
    const listed = await wb.gateway.call(listSpatialAssets, { query: {} }, wb.cell.as(wb.root));
    assert.deepEqual([listed.plans.length, listed.models.length, listed.anchors.length], [0, 0, 0]);
  });
});
