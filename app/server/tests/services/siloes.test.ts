// Siloes Capture and Import (spec 66, 67, 68, 70): the switch, Capture from real answers of
// the executor (baseline first, a transition only for a change), the history read and its
// building baseline, retention, every wipe with its receipt and impact, approval of a wipe,
// and Import from upload to rows, the carve-out, document extraction with its flag, and
// confirmation. BigQuery is the in-memory fake; object storage is in memory too.

import { replaySiloPurges } from '../../src/contracts/platform/purgeLedger.contract.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { getCloneStatesAt } from '../../src/contracts/canvas-layout/stateRule.contract.ts';
import { service as canvasLayoutService } from '../../src/routes/canvas-layout/index.route.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApprovalPolicy, decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { runPlan } from '../../src/contracts/executor/result.contract.ts';
import { readObjectView } from '../../src/contracts/executor/objectView.contract.ts';
import { createServer as createNetServer } from 'node:net';
import { applyMarking, createFieldPolicy, createMarking, retireFieldPolicy } from '../../src/contracts/policy/governance.contract.ts';
import { PLAN_SCHEMA_VERSION } from '../../src/contracts/planner/plan.contract.ts';
import {
  acknowledgeCarveout, beginUpload, completeUpload, confirmExtraction, draftDefinition, createImportSilo, createSource, getExtraction, listExtractions, listFiles, listSources, publishDefinition,
  listPrebuiltDefinitions, uploadFile,
} from '../../src/contracts/siloes/import.contract.ts';
import {
  addCaptureType, adoptMovedSiloes, changeRetention, createCaptureSilo, releaseMovedSiloes, getPurge, listPurges, getSilo, getSiloesWeb, removeCaptureType, previewPurge, readHistory, readObjectChanges, readStateAt, requestPurge, runRetentionSweep, setSiloesEnabled,
  type PurgeView, type SiloView,
} from '../../src/contracts/siloes/siloes.contract.ts';
import { getOrgExport, requestOrgExport } from '../../src/contracts/org-export/export.contract.ts';
import type { ObjectKey } from '../../src/infra/objectStorage.infra.ts';
import { createOrgExportService } from '../../src/routes/org-export/index.route.ts';
import { readTar } from '../../src/utils/tar.util.ts';
import { parquetReadObjects } from 'hyparquet';
import { gunzipSync } from 'node:zlib';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createImportLoaderService } from '../../src/routes/import-loader/index.route.ts';
import { createSiloesCaptureService } from '../../src/routes/siloes-capture/index.route.ts';
import { createSiloesImportService } from '../../src/routes/siloes-import/index.route.ts';
import { importTableOf } from '../../src/services/import-loader/loader.service.ts';
import { createSiloStore } from '../../src/services/connect-runtime/siloStore.service.ts';
import { configureDetector, runDetectors } from '../../src/contracts/recognition/detector.contract.ts';
import { investigate } from '../../src/contracts/recognition/association.contract.ts';
import { deriveEdges, observeLeadTimes } from '../../src/contracts/simulation/graph.contract.ts';
import { service as simulationService } from '../../src/routes/simulation/index.route.ts';
import { service as recognitionService } from '../../src/routes/recognition/index.route.ts';
import { zip } from '../../src/services/render/xlsx.service.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { writeRecords } from '../../src/contracts/connect-runtime/write.contract.ts';
import { getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { getManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { approveProposal, mergeProposal, openBranch, startDerivation, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { putLinkType, putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { startRecognitionCell, SUPPLIERS, type RecognitionCell } from './recognition.helper.ts';
import { createFakeBigQuery, type FakeBigQuery } from './warehouse.helper.ts';

let rc: RecognitionCell;
let bq: FakeBigQuery;
let gateway: RecognitionCell['gateway'];
const store = createMemoryStore();
const DAY = 86_400_000;
/** siloes-capture's clock, moved forward for the retention sweep only. */
let ahead = 0;

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sql = (text: string, values: unknown[] = []) => inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(text, values));
const events = async (name: string) => (await sql(
  `select payload -> 'detail' as detail from platform.outbox where organisation_id = $1 and payload ->> 'event' = $2 order by created_at`, [rc.cell.org, name],
)).rows.map((r) => r.detail as Record<string, unknown>);
const purged = (siloId: string, purgeId: string) => until('the purge to finish', async () => {
  const p = await gateway.call(getPurge, { params: { siloId, purgeId } }, rc.cell.as(rc.root));
  return p.status === 'completed' || p.status === 'failed' ? p : undefined;
});

/** Rows put back as a restore from an older backup would: each column as it was read. */
async function restoreRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, i) => '$' + String(i + 1)).join(', ');
    const values = columns.map((c) => {
      const v = row[c];
      return v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
    });
    await rc.cell.migrate.query(`insert into ${table} (${columns.join(', ')}) overriding system value values (${placeholders})`, values);
  }
}

/** One answer from the executor for the supplier type, as root: what Capture rides on. */
async function askSuppliers(properties: string[]): Promise<void> {
  const supplier = rc.type('supplier');
  await rc.cell.client('workspace').call(runPlan, {
    body: {
      plan: {
        schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: rc.manifest.version.id, nodes: [{ objectTypeId: supplier.id, filters: [] }], hops: [],
        select: properties.map((p) => ({ node: 0, property: rc.prop('supplier', p) })), sort: [],
      },
      parameters: {}, trigger: 'structured', useCache: false,
    },
  }, rc.cell.as(rc.root));
}

before(async () => {
  bq = createFakeBigQuery();
  // An Import Silo answers through connect-runtime, which reads it from the Silo store (66.5).
  // The executor asks siloes-import for extraction flags (34.3): its port is chosen first.
  const importPort = await new Promise<number>((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  rc = await startRecognitionCell([], {
    siloStore: createSiloStore(bq, 'silo-test-proj'), executorEnv: { SERVICE_URL_SILOES_IMPORT: `http://127.0.0.1:${importPort}` },
  });
  const env = {
    BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20',
    SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02', SILOES_CAPTURE_DRAIN_SECONDS: '1', SILOES_PURGE_POLL_SECONDS: '1', SILOES_IMPORT_PROCESS_SECONDS: '1',
    SILOES_RETENTION_SWEEP_SECONDS: '604800', BIGQUERY_METERING_INTERVAL_SECONDS: '86400', OBJECT_STORE: 's3', OBJECT_BUCKET_SILOES: 'silo-test-siloes',
    S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
  };
  await rc.cell.start(approvalsService, 'approvals', 'test_app');
  await rc.cell.start(createImportLoaderService({ bigQuery: bq }), 'import-loader', 'test_app', env);
  // siloes-capture asks siloes-import to rebuild an Import Silo after a move (D212): told its address before it starts.
  await rc.cell.start(createSiloesCaptureService({ store, now: () => Date.now() + ahead }), 'siloes-capture', 'test_app', { ...env, SERVICE_URL_SILOES_IMPORT: `http://127.0.0.1:${importPort}` });
  await rc.cell.start(createSiloesImportService({ store }), 'siloes-import', 'test_app', { ...env, HTTP_PORT: String(importPort) });
  // Recognition's history detectors read Capture (38.2): it starts after siloes-capture.
  await rc.cell.start(recognitionService, 'recognition', 'test_app');
  // Simulation's observed lead times read Capture too (39.3).
  await rc.cell.start(simulationService, 'simulation', 'test_app');
  await rc.cell.start(canvasLayoutService, 'canvas-layout', 'test_app', { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` });
  await rc.cell.start(createOrgExportService({ objects: store }), 'org-export', 'test_app', {
    ...env, OBJECT_BUCKET_FILES: 'silo-test-files', ORG_EXPORT_TICK_SECONDS: '1',
  });
  gateway = rc.cell.client('gateway');
});

after(async () => {
  await rc?.close();
});

// ----------------------------------------------------------------------------- the switch

describe('the switch (spec 66.1, 66.6)', () => {
  test('off means unreachable; only silo.enable turns it on', async () => {
    await assert.rejects(gateway.call(createCaptureSilo, { body: { name: 'History', purpose: 'Rating history', retentionDays: 30 } }, rc.keyed(rc.root)),
      { code: 'siloes.disabled' });
    await assert.rejects(gateway.call(setSiloesEnabled, { body: { enabled: true } }, rc.cell.as(rc.viewer)));
    const on = await gateway.call(setSiloesEnabled, { body: { enabled: true } }, rc.cell.as(rc.root));
    assert.equal(on.enabled, true);
    assert.match(on.disclosure, /Nothing is kept until you do/);
    assert.equal((await events('silo_enabled')).length, 1);
  });
});

// ----------------------------------------------------------------------------- Capture

describe('Capture (spec 67)', () => {
  let silo: SiloView;
  let changed: (typeof SUPPLIERS)[number];

  test('a Capture Silo states what it keeps; a type is added alone, by someone who can see it', async () => {
    silo = await gateway.call(createCaptureSilo, { body: { name: 'History', purpose: 'Rating history', retentionDays: 30 } }, rc.keyed(rc.root));
    assert.equal(silo.kind, 'capture');
    assert.equal(silo.status, 'active');
    await assert.rejects(gateway.call(addCaptureType, { params: { siloId: silo.id }, body: { objectTypeId: rc.type('supplier').id, properties: ['colour'] } },
      rc.cell.as(rc.root)), { code: 'siloes.unknown_property' });
    silo = await gateway.call(addCaptureType, { params: { siloId: silo.id }, body: { objectTypeId: rc.type('supplier').id, properties: ['rating'] } },
      rc.cell.as(rc.root));
    assert.deepEqual(silo.objectTypes.map((t) => t.objectTypeId), [rc.type('supplier').id]);
    assert.match(silo.disclosure, /previous and new values of .* on .* each time they change, in Postgres, europe-west2, for 30 days/);
    assert.match(silo.disclosure, /Nothing is kept the first time an object is seen/);
    assert.equal((await events('silo_concept_added')).length, 1);
  });

  test('the first answer is a baseline, never a transition; a change is one transition', async () => {
    await askSuppliers(['name', 'rating', 'region']);
    const baselines = await until('the baselines', async () => {
      const { rows } = await sql('select count(*)::int as n from siloes.silo_baselines where silo_id = $1', [silo.id]);
      return rows[0].n > 0 ? rows[0].n as number : undefined;
    });
    assert.equal(baselines, SUPPLIERS.length, 'one per supplier, rating only');
    assert.equal((await sql('select count(*)::int as n from siloes.transitions where silo_id = $1', [silo.id])).rows[0].n, 0);
    const { rows: props } = await sql('select distinct property from siloes.silo_baselines where silo_id = $1', [silo.id]);
    assert.deepEqual(props.map((r) => r.property), ['rating'], 'nothing outside the nomination');

    changed = SUPPLIERS.find((s) => s.id === 's07')!;
    const was = changed.rating;
    changed.rating = 77;
    try {
      await askSuppliers(['rating']);
      await until('a transition', async () => {
        const { rows } = await sql('select count(*)::int as n from siloes.transitions where silo_id = $1', [silo.id]);
        return rows[0].n > 0 ? true : undefined;
      });
    } finally {
      changed.rating = was;
    }
    const { rows } = await sql('select property, previous_value, new_value from siloes.transitions where silo_id = $1', [silo.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].property, 'rating');
    assert.ok(!Buffer.from(rows[0].new_value).toString('utf8').includes('77'), 'values are sealed at rest');
  });

  test('history is read through the reader\'s access, and a thin baseline is said to be building', async () => {
    const supplier = rc.type('supplier').id;
    const history = await rc.cell.client('recognition').call(readHistory, { body: { objectTypeId: supplier, property: 'rating' } }, rc.cell.as(rc.root));
    assert.equal(history.state, 'silo');
    assert.equal(history.transitions.length, 1);
    assert.deepEqual([history.transitions[0]!.previousValue, history.transitions[0]!.newValue], [10, 77]);
    assert.ok(history.capturedFrom !== null);

    const thin = await rc.cell.client('recognition').call(readHistory, { body: { objectTypeId: supplier, property: 'rating', minimumTransitions: 5 } },
      rc.cell.as(rc.root));
    assert.deepEqual([thin.state, thin.have, thin.need, thin.transitions.length], ['building', 1, 5, 0]);
    const none = await rc.cell.client('recognition').call(readHistory, { body: { objectTypeId: supplier, property: 'region' } }, rc.cell.as(rc.root));
    assert.equal(none.state, 'unavailable');
  });

  test('the object view\'s timeline: one object\'s observed changes, newest first, under the reader\'s field policy; without Capture, unavailable (34.4)', async () => {
    const supplier = rc.type('supplier').id;
    const opened = await gateway.call(readObjectView, { body: { objectTypeId: supplier, object: { connectionId: rc.crm, reference: changed.id } } }, rc.cell.as(rc.root));
    assert.equal(opened.outcome, 'object');
    const objectId = (opened as { view: { id: string } }).view.id;
    const changes = await gateway.call(readObjectChanges, { body: { objectTypeId: supplier, objectId } }, rc.cell.as(rc.root));
    assert.deepEqual([changes.state, changes.siloId, changes.properties, changes.next], ['silo', silo.id, ['rating'], null]);
    assert.ok(changes.capturedFrom !== null);
    assert.deepEqual(changes.changes.map((c) => [c.property, c.previousValue, c.newValue, c.withheld, c.connectionId]), [['rating', 10, 77, null, rc.crm]]);
    const other = await gateway.call(readObjectView, { body: { objectTypeId: supplier, object: { connectionId: rc.crm, reference: 's01' } } }, rc.cell.as(rc.root));
    assert.deepEqual((await gateway.call(readObjectChanges, { body: { objectTypeId: supplier, objectId: (other as { view: { id: string } }).view.id } },
      rc.cell.as(rc.root))).changes, [], 'another object\'s changes are its own');

    const policy = await gateway.call(createFieldPolicy, { body: { target: { propertyId: rc.prop('supplier', 'rating') }, effect: 'redact' } }, rc.cell.as(rc.root));
    try {
      const redacted = await gateway.call(readObjectChanges, { body: { objectTypeId: supplier, objectId } }, rc.cell.as(rc.root));
      assert.deepEqual(redacted.changes.map((c) => [c.previousValue, c.newValue, c.withheld]), [[null, null, 'redact']], 'the change is listed, its values withheld');
    } finally {
      await gateway.call(retireFieldPolicy, { params: { fieldPolicyId: policy.id } }, rc.cell.as(rc.root));
    }
    const uncaptured = await gateway.call(readObjectChanges, { body: { objectTypeId: rc.type('order').id, objectId } }, rc.cell.as(rc.root));
    assert.deepEqual([uncaptured.state, uncaptured.changes], ['unavailable', []], 'history requires Capture');
    assert.equal((await gateway.call(readObjectChanges, { body: { objectTypeId: uuidv7(), objectId } }, rc.cell.as(rc.root))).state, 'withheld');
  });

  test('the history detectors read what Capture holds, and never run on a thin baseline: they say how much there is and how much is needed (38.2, 67.4)', async () => {
    const supplier = rc.type('supplier');
    const rating = rc.prop('supplier', 'rating');
    for (const detector of ['timing_deviation', 'recurrence', 'drift']) {
      await gateway.call(configureDetector, { params: { objectTypeId: supplier.id, detector }, body: { properties: [rating] } }, rc.cell.as(rc.root));
    }
    const { runs } = await gateway.call(runDetectors, { body: { objectTypeId: supplier.id, detectors: ['timing_deviation', 'recurrence', 'drift'] } },
      rc.cell.as(rc.root));
    const by = new Map(runs.map((r) => [r.detector, r]));
    assert.deepEqual([by.get('timing_deviation')!.state, by.get('timing_deviation')!.baseline], ['accumulating_baseline', { have: 0, need: 30, unit: 'days' }]);
    assert.deepEqual([by.get('drift')!.state, by.get('drift')!.baseline], ['accumulating_baseline', { have: 0, need: 90, unit: 'days' }]);
    const recurrence = by.get('recurrence')!;
    assert.equal(recurrence.state, 'accumulating_baseline');
    assert.deepEqual([recurrence.baseline!.need, recurrence.baseline!.unit], [60, 'transitions']);
    assert.ok(recurrence.baseline!.have >= 1, 'the change captured above counts');
    // A type no Silo captures: history is unavailable, not building.
    await gateway.call(configureDetector, { params: { objectTypeId: rc.type('order').id, detector: 'recurrence' }, body: { properties: [rc.prop('order', 'supplier_id')] } },
      rc.cell.as(rc.root));
    const elsewhere = await gateway.call(runDetectors, { body: { objectTypeId: rc.type('order').id, detectors: ['recurrence'] } }, rc.cell.as(rc.root));
    assert.equal(elsewhere.runs[0]!.state, 'history_unavailable');
  });

  test('an observed lead time needs both ends captured and enough observations; until then it says so and proposes nothing (39.3, 67.4)', async () => {
    const link = rc.link('supplier_orders');
    const derived = await gateway.call(deriveEdges, { body: { linkTypeIds: [link.id] } }, rc.cell.as(rc.root));
    const edge = derived.proposed[0]!;
    const observe = (version: number) => gateway.call(observeLeadTimes, {
      params: { edgeId: edge.id }, body: { upstreamProperty: 'rating', downstreamProperty: 'supplier_id', version },
    }, rc.cell.as(rc.root));
    const first = await observe(edge.version);
    assert.deepEqual([first.state, first.need, first.edge.source], ['unavailable', 30, 'structure'], 'orders are not captured');
    const history = (await sql(`select id from siloes.siloes where kind = 'capture' and disabled_at is null`)).rows[0].id as string;
    await gateway.call(addCaptureType, { params: { siloId: history }, body: { objectTypeId: rc.type('order').id, properties: ['supplier_id'] } }, rc.cell.as(rc.root));
    const second = await observe(edge.version);
    assert.deepEqual([second.state, second.have, second.need, second.distribution, second.edge.leadTime], ['building', 0, 30, null, null],
      'captured, but nothing observed yet: no lead time is proposed');
    await gateway.call(removeCaptureType, { params: { siloId: history, objectTypeId: rc.type('order').id } }, rc.cell.as(rc.root));
  });

  test('time (30.8): each captured property as it stood at a past time, with when it was observed; not captured, not yet observed; compare', async () => {
    const supplier = rc.type('supplier').id;
    const { rows } = await sql('select object_ref, observed_at from siloes.transitions where silo_id = $1', [silo.id]);
    const ref = rows[0].object_ref as string;
    const changedAt = new Date(rows[0].observed_at).getTime();
    const { rows: seen } = await sql('select first_seen_at from siloes.silo_baselines where silo_id = $1 and object_ref = $2', [silo.id, ref]);
    const firstSeen = new Date(seen[0].first_seen_at).getTime();
    assert.ok(firstSeen < changedAt);
    const iso = (ms: number) => new Date(ms).toISOString();
    const canvas = rc.cell.client('canvas-layout');
    const read = (at: number) => canvas.call(readStateAt, { body: { objectTypeId: supplier, objectRefs: [ref], properties: ['rating', 'region'], at: iso(at) } },
      rc.cell.as(rc.root));

    const early = await read(firstSeen - 60_000);
    assert.equal(early.objects[0]!.observed, false, 'first seen after the time: not yet observed');
    assert.deepEqual(early.properties, [{ property: 'rating', availability: 'captured' }, { property: 'region', availability: 'not_captured' }]);
    const between = await read(Math.floor((firstSeen + changedAt) / 2));
    assert.deepEqual(between.objects[0]!.values, { rating: { value: 10, observedAt: iso(firstSeen) } }, 'the baseline\'s value, observed when first seen');
    const later = await read(changedAt + 1_000);
    assert.deepEqual(later.objects[0]!.values, { rating: { value: 77, observedAt: iso(changedAt) } });
    assert.ok(!('region' in later.objects[0]!.values), 'a property not captured never shows its current value');

    const compared = await gateway.call(getCloneStatesAt, {
      body: { objectTypeId: supplier, objectRefs: [ref], properties: ['rating'], at: iso(Math.floor((firstSeen + changedAt) / 2)), compareTo: iso(changedAt + 1_000) },
    }, rc.cell.as(rc.root));
    assert.equal(compared.available, true);
    assert.deepEqual(compared.differences!.properties.map((d) => [d.property, d.at.value, d.compareTo.value]), [['rating', 10, 77]]);
    assert.deepEqual([compared.differences!.onlyAt, compared.differences!.onlyCompareTo], [[], []]);

    const unavailable = await gateway.call(getCloneStatesAt, {
      body: { objectTypeId: rc.type('order').id, objectRefs: ['x'], properties: ['order_id'], at: iso(changedAt) },
    }, rc.cell.as(rc.root));
    assert.deepEqual([unavailable.available, unavailable.reason], [false, 'History is not retained. Enable Siloes Capture for this object type to compare times.']);
    // Compare recorded with what differed (30.8); asked without Capture, refused and recorded.
    assert.deepEqual((await events('time_compared')).map((d) => [d['properties_changed'], d['objects']]), [[1, 1]]);
    await gateway.call(getCloneStatesAt, {
      body: { objectTypeId: rc.type('order').id, objectRefs: ['x'], properties: ['order_id'], at: iso(changedAt), compareTo: iso(changedAt + 1_000) },
    }, rc.cell.as(rc.root));
    assert.equal((await events('time_compare_refused_no_capture')).length, 1);
  });

  test('lengthening needs silo.manage, shortening silo.purge; both windows are audited', async () => {
    await assert.rejects(gateway.call(changeRetention, { params: { siloId: silo.id }, body: { retentionDays: 60 } }, rc.cell.as(rc.viewer)));
    silo = await gateway.call(changeRetention, { params: { siloId: silo.id }, body: { retentionDays: 60 } }, rc.cell.as(rc.root));
    assert.equal(silo.retentionDays, 60);
    assert.match(silo.disclosure, /for 60 days/);
    silo = await gateway.call(changeRetention, { params: { siloId: silo.id }, body: { retentionDays: 30 } }, rc.cell.as(rc.root));
    const changes = await events('retention_changed');
    assert.deepEqual(changes.map((d) => [d['previous_days'], d['new_days']]), [[30, 60], [60, 30]]);
  });

  test('purge entity: the preview states what stops working; the wipe drains, deletes and leaves a receipt', async () => {
    const supplier = rc.type('supplier').id;
    const { rows } = await sql('select object_ref from siloes.transitions where silo_id = $1', [silo.id]);
    const objectRef = rows[0].object_ref as string;
    const preview = await gateway.call(previewPurge, { params: { siloId: silo.id }, body: { scope: 'entity', objectTypeId: supplier, objectRef } },
      rc.cell.as(rc.root));
    assert.equal(preview.approvalsRequired, 0);
    assert.deepEqual(preview.impact.detectors.map((d) => d.detector).sort(), ['drift', 'recurrence', 'timing_deviation']);
    assert.deepEqual(preview.impact.timelines, [supplier]);
    await assert.rejects(gateway.call(requestPurge, { params: { siloId: silo.id }, body: { scope: 'file', fileId: uuidv7() } }, rc.cell.as(rc.root)),
      { code: 'siloes.purge_scope' });

    // What a backup taken before the purge holds (D251).
    const backedUp = {
      transitions: (await rc.cell.migrate.query('select * from siloes.transitions where silo_id = $1 and object_ref = $2', [silo.id, objectRef])).rows,
      baselines: (await rc.cell.migrate.query('select * from siloes.silo_baselines where silo_id = $1 and object_ref = $2', [silo.id, objectRef])).rows,
    };
    const asked = await gateway.call(requestPurge, { params: { siloId: silo.id }, body: { scope: 'entity', objectTypeId: supplier, objectRef } }, rc.cell.as(rc.root));
    assert.equal(asked.approvalChainId, null, 'no chain configured: the requester is the approver');
    const done = await purged(silo.id, asked.id);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.deepEqual(done.receipt!.removed['postgres'], { transitions: 1, baselines: 1 });
    // Listed with its Silo's purges, its receipt written, so it is found again (D270).
    const listed = (await gateway.call(listPurges, { params: { siloId: silo.id }, query: {} }, rc.cell.as(rc.root))).purges;
    assert.deepEqual(listed.filter((x) => x.id === asked.id).map((x) => [x.scope, x.status, x.receipt, x.objectRef]), [['entity', 'completed', true, objectRef]]);
    assert.equal((await sql('select count(*)::int as n from siloes.transitions where silo_id = $1 and object_ref = $2', [silo.id, objectRef])).rows[0].n, 0);
    assert.equal((await sql('select count(*)::int as n from siloes.purge_receipts where silo_id = $1', [silo.id])).rows[0].n, 1);
    for (const e of ['purge_requested', 'capture_queue_drained', 'purge_completed']) assert.ok((await events(e)).length > 0, e);

    // The purge ledger (8.2, 12.5; D251): written with the purge, outside what a restore rewinds; replayed after one.
    const { rows: [ledger] } = await rc.cell.migrate.query(
      `select id, organisation_id, created_at, correlation_id, payload from platform.outbox where topic = 'platform.purge_ledger' and payload->>'purgeId' = $1`, [asked.id]);
    assert.deepEqual(ledger.payload, { kind: 'silo_wipe', siloId: silo.id, purgeId: asked.id, scope: 'entity', objectTypeId: supplier, objectRef });
    // A restore from before the purge brings the rows back...
    await restoreRows('siloes.transitions', backedUp.transitions);
    await restoreRows('siloes.silo_baselines', backedUp.baselines);
    assert.equal((await sql('select count(*)::int as n from siloes.transitions where silo_id = $1 and object_ref = $2', [silo.id, objectRef])).rows[0].n, 1, 'restored');
    // ...and the ledger's replay wipes them again before the cell opens.
    const replayed = await rc.cell.client('maintenance').call(replaySiloPurges, { body: { entries: [{
      id: ledger.id, organisationId: ledger.organisation_id, occurredAt: new Date(ledger.created_at).toISOString(), correlationId: ledger.correlation_id, entry: ledger.payload,
    }] } }, { correlationId: uuidv7() });
    assert.deepEqual(replayed, { replayed: 1, skipped: 0 });
    assert.equal((await sql('select count(*)::int as n from siloes.transitions where silo_id = $1 and object_ref = $2', [silo.id, objectRef])).rows[0].n, 0, 'purged again');
    assert.equal((await sql('select count(*)::int as n from siloes.silo_baselines where silo_id = $1 and object_ref = $2', [silo.id, objectRef])).rows[0].n, 0);
  });

  // Last in Capture: the gaps question reads suppliers through the executor, and Capture observes every such answer.
  test('investigation over Capture (38.8): the history part answers where a Silo holds the type, and only for what it captures', async () => {
    const ask = (question: 'gaps' | 'anomalies' | 'clusters', typeName: string) =>
      gateway.call(investigate, { body: { question, objectTypeId: rc.type(typeName).id } }, rc.cell.as(rc.root));
    const anomalies = await ask('anomalies', 'supplier');
    assert.deepEqual([anomalies.history, anomalies.capturedProperties, anomalies.requiresCapture], ['held', ['rating'], []]);
    assert.deepEqual(anomalies.historical.map((p) => [p.detector, p.kind]), [['timing_deviation', 'detector_state'], ['drift', 'detector_state']]);
    assert.equal(anomalies.historical[0]!.statement, 'Timing deviation is building a baseline on Suppliers: 0 of 30 days.');
    const clusters = await ask('clusters', 'supplier');
    assert.deepEqual([clusters.history, clusters.requiresCapture], ['held', []]);
    assert.deepEqual(clusters.historical.map((p) => p.detector), ['recurrence']);
    assert.match(clusters.historical[0]!.statement, /^Recurrence is building a baseline on Suppliers: \d+ of 60 transitions\.$/);
    // Email and registration are empty somewhere, but only rating is captured: when they emptied is named as unanswerable.
    const gaps = await ask('gaps', 'supplier');
    assert.deepEqual(gaps.historical, []);
    assert.deepEqual([...gaps.requiresCapture].sort(), [
      'When Email became empty needs it captured: it is not in the Capture Silo.',
      'When Registration became empty needs it captured: it is not in the Capture Silo.',
    ]);
    // A type no Silo captures: nothing history-dependent, and what it cannot answer named.
    const orders = await ask('clusters', 'order');
    assert.deepEqual([orders.history, orders.current, orders.historical, orders.findings], ['not_held', [], [], []]);
    assert.equal(orders.requiresCapture.length, 1);
  });
});

// ----------------------------------------------------------------------------- Import

describe('Import (spec 68)', () => {
  let silo: SiloView;
  let uploads: string;
  let definitionId: string;
  const csv = 'Invoice,Supplier,Amount,Date\nINV-1,Acme Ltd,120.50,2026-10-01\nINV-2,Brill plc,99,2026-10-02\nINV-3,Cobalt,,2026-10-03\n';
  const upload = (filename: string, text: string, sourceId = uploads) => gateway.call(uploadFile, {
    params: { siloId: silo.id, sourceId }, body: { filename, contentBase64: Buffer.from(text).toString('base64') },
  }, rc.keyed(rc.root));
  const processed = (fileId: string) => until('the file to be processed', async () => {
    const { files } = await gateway.call(listFiles, { params: { siloId: silo.id } }, rc.cell.as(rc.root));
    const f = files.find((x) => x.id === fileId)!;
    return f.status === 'received' ? undefined : f;
  });

  test('an Import Silo and its definition: a model is refused until the carve-out is acknowledged', async () => {
    silo = await gateway.call(createImportSilo, { body: { name: 'Archive', purpose: 'Old invoices', retentionDays: 365 } }, rc.keyed(rc.root));
    assert.equal(silo.kind, 'import');
    assert.match(silo.disclosure, /No model reads these files/);
    await assert.rejects(gateway.call(publishDefinition, {
      params: { siloId: silo.id },
      body: { route: 'builder', document: { objects: [{ name: 'Notes', fields: [{ name: 'subject', type: 'string', extraction: { kind: 'label', label: 'Subject' } }] }] } },
    }, rc.cell.as(rc.root)), { code: 'import.carveout_required' });
    const published = await gateway.call(publishDefinition, {
      params: { siloId: silo.id },
      body: {
        route: 'builder', document: {
          objects: [{
            name: 'Invoices', identifier: 'invoice_no', fields: [
              { name: 'invoice_no', type: 'string', extraction: { kind: 'column', column: 'Invoice' } },
              { name: 'supplier_name', type: 'string', extraction: { kind: 'column', column: 'Supplier' } },
              { name: 'amount', type: 'decimal', extraction: { kind: 'column', column: 'Amount' } },
              { name: 'invoiced', type: 'date', extraction: { kind: 'column', column: 'Date' } },
            ],
          }],
        },
      },
    }, rc.cell.as(rc.root));
    assert.deepEqual([published.version, published.requiresModel], [1, false]);
    definitionId = published.id;
    uploads = (await gateway.call(createSource, { params: { siloId: silo.id }, body: { kind: 'upload', definitionId } }, rc.cell.as(rc.root))).id;
  });

  test('a tabular file is stored under a key without its name, read column by column, every value certain', async () => {
    const file = await upload('invoices 2019.csv', csv);
    assert.deepEqual([file.contentType, file.contentClass, file.status], ['text/csv', 'tabular', 'received']);
    const key = store.keys('siloes').find((k) => k.endsWith(file.id))!;
    assert.equal(key, `org/${rc.cell.org}/silo/${silo.id}/files/${file.id}`);
    assert.equal((await processed(file.id)).status, 'processed');
    const rows = bq.table(importTableOf('Invoices'))!.appended;
    assert.deepEqual(rows.map((r) => [r['_row_ref'], r['amount']]), [['INV-1', '120.50'], ['INV-2', '99'], ['INV-3', null]]);
    assert.ok(!bq.table(importTableOf('Invoices'))!.columns.some((c) => c.name.endsWith('__method')), 'no method columns: nothing is uncertain');
    const failed = await upload('bad.csv', 'Invoice,Supplier,Amount,Date\nINV-9,Delta,not-a-number,2026-10-09\n');
    const f = await processed(failed.id);
    assert.equal(f.status, 'failed');
    assert.equal(f.errorStage, 'tabular:import.cell_type');
    assert.ok(!JSON.stringify(await events('file_failed')).includes('not-a-number'), 'a failure names its stage, never a value');
  });

  test('it answers as a source: a connection whose manifest is its definition, read in its store, never written, derived like any other (66.5, 68.5)', async () => {
    const { rows: [row] } = await sql('select status, source_connection_id from siloes.siloes where id = $1', [silo.id]);
    assert.equal(row.status, 'active', 'out of provisioning once the federated engine can plan against it');
    const connectionId = row.source_connection_id as string;
    const connection = await gateway.call(getConnection, { params: { connectionId } }, rc.cell.as(rc.root));
    assert.deepEqual([connection.status, connection.provider, connection.writesEnabled], ['active', 'silo', false]);
    const version = await gateway.call(getManifestVersion, { params: { connectorId: connection.connectorId, versionId: connection.manifestId } }, rc.cell.as(rc.root));
    const document = version.document as { transport: { store: { siloId: string } }; objects: { name: string; identifier: string[]; source: { table: string } }[] };
    assert.deepEqual([version.sourceRoute, document.transport.store.siloId], ['silo', silo.id]);
    assert.deepEqual(document.objects.map((o) => [o.name, o.identifier, o.source.table]), [['invoices', ['invoice_no'], importTableOf('Invoices')]]);

    const read = await rc.cell.client('executor').call(readObject, { body: { connectionId, reason: 'query', step: { object: 'invoices' } } }, rc.cell.as(rc.root));
    assert.deepEqual(read.rows.map((r) => [r['invoice_no'], r['supplier_name'], r['amount']]),
      [['INV-1', 'Acme Ltd', 120.5], ['INV-2', 'Brill plc', 99], ['INV-3', 'Cobalt', null]], 'typed as the definition declares');
    const statement = bq.statements.at(-1)!;
    assert.match(statement.text.replace(/\s+/g, ' '), /where `_received_at` >= @p1/, 'every read filters the partition column');
    // Even the sandbox path that verifies a write class is refused: a Silo holds a copy.
    await assert.rejects(rc.cell.client('conformance').call(writeRecords, { body: {
      connectionId, object: 'invoices', sandbox: true, operations: [{ key: uuidv7(), operation: 'update_partial', identifier: 'INV-1', values: { amount: 1 } }],
    } }, rc.cell.as(rc.root)), { code: 'write.silo_read_only' });

    // 68.5: derivation treats the Silo's objects as it treats any other contributing object.
    const derived = await gateway.call(startDerivation, { body: { connectionId } }, rc.keyed(rc.root));
    assert.ok(derived.decisions.some((d) => d.kind === 'object_type' && d.apiName.startsWith('invoice')), JSON.stringify(derived.decisions.map((d) => d.apiName)));
  });

  test('Siloes link to elements within one another (66.9; D248): a component in one Silo, its specification in another, returned in one answer', async () => {
    // Two Import Siloes, each answering as its own source.
    const siloOf = async (name: string, object: string, fields: { name: string; column: string }[], identifier: string, csvText: string) => {
      const made = await gateway.call(createImportSilo, { body: { name, purpose: `${name} of the plant`, retentionDays: 365 } }, rc.keyed(rc.root));
      const definition = await gateway.call(publishDefinition, {
        params: { siloId: made.id },
        body: { route: 'builder', document: { objects: [{ name: object, identifier, fields: fields.map((f) => ({ name: f.name, type: 'string' as const, extraction: { kind: 'column' as const, column: f.column } })) }] } },
      }, rc.cell.as(rc.root));
      const source = await gateway.call(createSource, { params: { siloId: made.id }, body: { kind: 'upload', definitionId: definition.id } }, rc.cell.as(rc.root));
      const file = await gateway.call(uploadFile, {
        params: { siloId: made.id, sourceId: source.id }, body: { filename: `${object}.csv`, contentBase64: Buffer.from(csvText).toString('base64') },
      }, rc.keyed(rc.root));
      await until(`${name} to take its file in`, async () => {
        const { files } = await gateway.call(listFiles, { params: { siloId: made.id } }, rc.cell.as(rc.root));
        return files.find((f) => f.id === file.id)?.status === 'processed' ? true : undefined;
      });
      await until(`${name} to answer`, async () => {
        const { rows: [row] } = await sql('select status, source_connection_id from siloes.siloes where id = $1', [made.id]);
        return row.status === 'active' ? row.source_connection_id as string : undefined;
      });
      return (await sql('select source_connection_id from siloes.siloes where id = $1', [made.id])).rows[0].source_connection_id as string;
    };
    const parts = await siloOf('Components', 'Components', [{ name: 'component_no', column: 'Component' }, { name: 'spec_ref', column: 'Spec' }], 'component_no',
      'Component,Spec\nC-1,SP-1\nC-2,SP-2\nC-3,SP-1\n');
    const specs = await siloOf('Specifications', 'Specifications', [{ name: 'spec_no', column: 'Spec' }, { name: 'title', column: 'Title' }], 'spec_no',
      'Spec,Title\nSP-1,Pump casing to BS EN 733\nSP-2,Valve body to BS EN 1074\n');

    const branch = await gateway.call(openBranch, { body: { name: 'plant records' } }, rc.keyed(rc.editor));
    const m = (connectionId: string, sourceObject: string, fieldPath: string) => ({ connectionId, sourceObject, fieldPath });
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'component' }, body: {
      displayName: 'Component', pluralName: 'Components', contributingObjects: [{ connectionId: parts, sourceObject: 'components', identifierFieldPath: 'component_no' }],
      properties: [
        { apiName: 'component_no', displayName: 'Component', dataType: 'string', mappings: [m(parts, 'components', 'component_no')] },
        { apiName: 'spec_ref', displayName: 'Specification', dataType: 'string', mappings: [m(parts, 'components', 'spec_ref')] },
      ],
      primaryKey: 'component_no', title: 'component_no',
    } as never }, rc.keyed(rc.editor));
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'specification' }, body: {
      displayName: 'Specification', pluralName: 'Specifications', contributingObjects: [{ connectionId: specs, sourceObject: 'specifications', identifierFieldPath: 'spec_no' }],
      properties: [
        { apiName: 'spec_no', displayName: 'Specification', dataType: 'string', mappings: [m(specs, 'specifications', 'spec_no')] },
        { apiName: 'title', displayName: 'Title', dataType: 'string', mappings: [m(specs, 'specifications', 'title')] },
      ],
      primaryKey: 'spec_no', title: 'title',
    } as never }, rc.keyed(rc.editor));
    const route = { connectionId: parts, sourceObject: 'components', foreignKeyField: 'spec_ref', referencedField: 'spec_no', referencedConnectionId: specs, referencedObject: 'specifications' };
    const putLink = (routes: unknown[]) => gateway.call(putLinkType, {
      params: { branchId: branch.id, apiName: 'specifies' },
      body: { forwardName: 'specifies', reverseName: 'specified by', from: 'specification', to: 'component', cardinality: 'one_to_many', routes, defaultRoute: 0 } as never,
    }, rc.keyed(rc.editor));
    await assert.rejects(putLink([{ ...route, origin: 'declared_fk' }]), { code: 'ontology.route_not_declared' }, 'no manifest declares a key into another system');
    await assert.rejects(putLink([{ ...route, referencedObject: 'components', origin: 'person_declared' }]), { code: 'ontology.route_reference' });
    await assert.rejects(putLink([{ ...route, referencedObject: undefined, origin: 'person_declared' }]), { code: 'ontology.route_reference' });
    await putLink([{ ...route, origin: 'person_declared' }]);
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Plant records' } }, rc.keyed(rc.editor));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, rc.cell.as(rc.root));
    const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, rc.keyed(rc.root));
    const manifest = await gateway.call(getManifest, { query: {} }, rc.cell.as(rc.root));
    const component = manifest.objectTypes.find((t) => t.apiName === 'component')!;
    const specification = manifest.objectTypes.find((t) => t.apiName === 'specification')!;
    const link = manifest.linkTypes.find((l) => l.apiName === 'specifies')!;
    assert.deepEqual([link.routes[0]!.referencedConnectionId, link.routes[0]!.referencedObject], [specs, 'specifications']);
    const propOf = (t: typeof component, apiName: string) => t.properties.find((p) => p.apiName === apiName)!.identityId;

    // One plan: each component with its specification, read from the other Silo in the same answer.
    const out = await rc.cell.client('workspace').call(runPlan, {
      body: {
        plan: {
          schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: merged.version.id,
          nodes: [{ objectTypeId: component.id, filters: [] }, { objectTypeId: specification.id, filters: [] }],
          hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId: link.routes[0]!.id }],
          select: [{ node: 0, property: propOf(component, 'component_no') }, { node: 1, property: propOf(specification, 'title') }], sort: [],
        },
        parameters: {}, trigger: 'structured', useCache: false,
      },
    }, rc.cell.as(rc.root)) as unknown as { outcome: string; result: { page: { objects: { values: Record<string, unknown>; links: Record<string, { values: Record<string, unknown> }[]> }[] } } };
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 600));
    assert.deepEqual(out.result.page.objects.map((o) => `${o.values['component_no']}: ${o.links['0']!.map((s) => s.values['title']).join(', ')}`).sort(),
      ['C-1: Pump casing to BS EN 733', 'C-2: Valve body to BS EN 1074', 'C-3: Pump casing to BS EN 733']);

    // A component's object view names its specification among its links.
    const opened = await gateway.call(readObjectView, { body: { objectTypeId: component.id, object: { connectionId: parts, reference: 'C-2' } } }, rc.cell.as(rc.root));
    assert.equal(opened.outcome, 'object', JSON.stringify(opened).slice(0, 400));
    if (opened.outcome !== 'object') return;
    const specified = opened.view.links.find((l) => l.linkTypeId === link.id)!;
    assert.deepEqual([specified.direction, specified.count, specified.objects.map((o) => o.title)], ['reverse', 1, ['Valve body to BS EN 1074']]);
  });

  test('mapped to an object type, its rows go when that concept is purged (66.5, 70)', async () => {
    const { rows: [row] } = await sql('select source_connection_id from siloes.siloes where id = $1', [silo.id]);
    const connectionId = row.source_connection_id as string;
    const branch = await gateway.call(openBranch, { body: { name: 'archive' } }, rc.keyed(rc.editor));
    const m = (fieldPath: string) => ({ connectionId, sourceObject: 'invoices', fieldPath });
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'archived_invoice' }, body: {
      displayName: 'Archived invoice', pluralName: 'Archived invoices', contributingObjects: [{ connectionId, sourceObject: 'invoices', identifierFieldPath: 'invoice_no' }],
      properties: [
        { apiName: 'invoice_no', displayName: 'Invoice', dataType: 'string', mappings: [m('invoice_no')] },
        { apiName: 'amount', displayName: 'Amount', dataType: 'decimal', mappings: [m('amount')] },
      ],
      primaryKey: 'invoice_no', title: 'invoice_no',
    } as never }, rc.keyed(rc.editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Archive' } }, rc.keyed(rc.editor));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, rc.cell.as(rc.root));
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, rc.keyed(rc.root));
    const type = (await gateway.call(getManifest, { query: {} }, rc.cell.as(rc.root))).objectTypes.find((t) => t.apiName === 'archived_invoice')!;
    assert.ok(bq.table(importTableOf('Invoices'))!.appended.length > 0);

    const asked = await gateway.call(requestPurge, { params: { siloId: silo.id }, body: { scope: 'concept', objectTypeId: type.id } }, rc.cell.as(rc.root));
    assert.equal((await purged(silo.id, asked.id)).status, 'completed');
    const left = bq.table(importTableOf('Invoices'));
    assert.ok(left === undefined || left.appended.length + left.rows.size === 0, 'the concept\'s imported rows are gone');
  });

  test('an Excel workbook is read like a CSV: its first sheet by columns, certain, its serial dates as dates, no model (68.2)', async () => {
    const asked = rc.modelRequests.length;
    const sheet = '<row r="1"><c r="A1" t="inlineStr"><is><t>Invoice</t></is></c><c r="B1" t="inlineStr"><is><t>Supplier</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>Amount</t></is></c><c r="D1" t="inlineStr"><is><t>Date</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>INV-7</t></is></c><c r="B2" t="inlineStr"><is><t>Delta</t></is></c><c r="C2"><v>15.25</v></c><c r="D2"><v>46296</v></c></row>';
    const bytes = zip([
      ['[Content_Types].xml', Buffer.from('<Types/>')],
      ['xl/workbook.xml', Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="Invoices" sheetId="1" r:id="rId1"/></sheets></workbook>')],
      ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')],
      ['xl/worksheets/sheet1.xml', Buffer.from(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`)],
    ]);
    const file = await gateway.call(uploadFile, {
      params: { siloId: silo.id, sourceId: uploads }, body: { filename: 'invoices 2021.xlsx', contentBase64: bytes.toString('base64') },
    }, rc.keyed(rc.root));
    assert.deepEqual([file.contentClass, file.contentType], ['tabular', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    assert.equal((await processed(file.id)).status, 'processed', JSON.stringify(await events('file_failed')));
    const row = bq.table(importTableOf('Invoices'))!.appended.find((r) => r['_row_ref'] === 'INV-7')!;
    assert.deepEqual([row['supplier_name'], row['amount'], row['invoiced']], ['Delta', '15.25', '2026-10-01']);
    assert.equal(rc.modelRequests.length, asked, 'tabular import never invokes a model');
  });

  test('a definition drafted from one of its own tabular files: inferred, probed against every row, confirmed by publishing (68.3)', async () => {
    const csvFile = (await gateway.call(listFiles, { params: { siloId: silo.id } }, rc.cell.as(rc.root))).files.find((f) => f.filename === 'invoices 2019.csv')!;
    const asked = rc.modelRequests.length;
    const drafted = await gateway.call(draftDefinition, { params: { siloId: silo.id }, body: { fileId: csvFile.id } }, rc.cell.as(rc.root));
    const object = drafted.document.objects[0]!;
    assert.equal(object.name, 'invoices 2019');
    assert.deepEqual(object.fields.map((f) => [f.name, f.type]), [['invoice', 'string'], ['supplier', 'string'], ['amount', 'decimal'], ['date', 'date']]);
    assert.deepEqual([drafted.probe.rows, drafted.probe.fields.map((f) => f.unreadable)], [3, [0, 0, 0, 0]]);
    assert.ok(!JSON.stringify(drafted).includes('Acme'), 'structure and counts, never a value');
    assert.equal(rc.modelRequests.length, asked, 'no model drafts a tabular file');
    const published = await gateway.call(publishDefinition, { params: { siloId: silo.id }, body: { route: 'ai', document: drafted.document } }, rc.cell.as(rc.root));
    assert.equal(published.route, 'ai');
  });

  test('a large file goes straight to storage on a signed, short-lived resumable URL, then is received like any upload', async () => {
    await assert.rejects(gateway.call(beginUpload, { params: { siloId: silo.id, sourceId: uploads }, body: { sizeBytes: 64 * 1024 * 1024 } }, rc.cell.as(rc.root)),
      { code: 'import.file_too_large' });
    await assert.rejects(gateway.call(beginUpload, { params: { siloId: silo.id, sourceId: uploads }, body: { sizeBytes: 100 } }, rc.cell.as(rc.viewer)));
    const begun = await gateway.call(beginUpload, { params: { siloId: silo.id, sourceId: uploads }, body: { sizeBytes: 100 } }, rc.cell.as(rc.root));
    const key = begun.url.replace('memory://siloes/', '');
    assert.equal(key, `org/${rc.cell.org}/silo/${silo.id}/drop/${uploads}/${begun.uploadId}`, 'into the source\'s drop prefix, under no filename');
    assert.ok(Date.parse(begun.expiresAt) - Date.now() <= 15 * 60_000);
    await assert.rejects(gateway.call(completeUpload, { params: { siloId: silo.id, sourceId: uploads, uploadId: begun.uploadId }, body: { filename: 'big.csv' } },
      rc.keyed(rc.root)), { code: 'import.upload_not_found' });
    await store.put('siloes', key as never, Buffer.from('Invoice,Supplier,Amount,Date\nINV-8,Echo,1.5,2026-10-08\n'), 'application/octet-stream');
    const file = await gateway.call(completeUpload, { params: { siloId: silo.id, sourceId: uploads, uploadId: begun.uploadId }, body: { filename: 'big.csv' } },
      rc.keyed(rc.root));
    assert.deepEqual([file.id, file.contentClass, file.filename], [begun.uploadId, 'tabular', 'big.csv']);
    assert.equal(store.keys('siloes').includes(key), false, 'the drop object is removed once received');
    assert.equal((await processed(file.id)).status, 'processed');
  });

  test('the Siloes page: each Silo, what it holds and when it last took data in, and the links between Siloes and why (66.9)', async () => {
    const supplier = rc.type('supplier').id;
    const history = (await sql(`select id from siloes.siloes where kind = 'capture' and disabled_at is null`)).rows[0].id as string;
    const audit = await gateway.call(createCaptureSilo, { body: { name: 'Supplier audit', purpose: 'Rating audit trail', retentionDays: 60 } }, rc.keyed(rc.root));
    await gateway.call(addCaptureType, { params: { siloId: audit.id }, body: { objectTypeId: supplier, properties: ['rating'] } }, rc.cell.as(rc.root));
    const web = await gateway.call(getSiloesWeb, {}, rc.cell.as(rc.root));
    const archive = (await gateway.call(getManifest, { query: {} }, rc.cell.as(rc.root))).objectTypes.find((t) => t.apiName === 'archived_invoice')!;
    const imported = web.siloes.find((x) => x.id === silo.id)!;
    assert.deepEqual(imported.heldTypeIds, [archive.id], 'an Import Silo holds the types its objects are mapped to');
    assert.ok(imported.lastUpdatedAt !== null, 'its files were processed');
    assert.deepEqual([imported.purpose, imported.retentionDays], ['Old invoices', 365]);
    const link = web.links.find((l) => [l.from, l.to].includes(history) && [l.from, l.to].includes(audit.id))!;
    assert.deepEqual([link.why, link.objectTypeIds], [['same_type'], [supplier]], 'retrieval from one reaches the other');
    assert.ok(!web.links.some((l) => [l.from, l.to].includes(silo.id)), 'nothing joins the archive to the others');
    assert.equal(web.presentation, 'graph');
  });

  test('documents: acknowledged by silo.enable, read by the model, each value flagged with its location and score, confirmed by a person', async () => {
    await assert.rejects(gateway.call(acknowledgeCarveout, { params: { siloId: silo.id } }, rc.cell.as(rc.viewer)));
    const ack = await gateway.call(acknowledgeCarveout, { params: { siloId: silo.id } }, rc.cell.as(rc.root));
    assert.match(ack.disclosure, /zero-retention endpoint/);
    const notes = await gateway.call(publishDefinition, {
      params: { siloId: silo.id },
      body: { route: 'builder', document: { objects: [{ name: 'Notes', fields: [{ name: 'subject', type: 'string', extraction: { kind: 'prose', instruction: 'What the note is about' } }] }] } },
    }, rc.cell.as(rc.root));
    assert.equal(notes.requiresModel, true);
    const documents = await gateway.call(createSource, { params: { siloId: silo.id }, body: { kind: 'upload', definitionId: notes.id } }, rc.cell.as(rc.root));
    rc.modelReplies.push({ rows: [{ object: 'Notes', fields: { subject: { value: 'Late delivery', location: 'line 2', confidence: 0.82 } } }] });
    const file = await upload('note.txt', 'From: buyer\nThe delivery was late again.\n', documents.id);
    assert.equal(file.contentClass, 'prose');
    assert.equal((await processed(file.id)).status, 'processed', JSON.stringify(await events('file_failed')));
    const { rows: charged } = await sql(`select count(*)::int as n from billing.token_transactions where silo_file_id = $1`, [file.id]);
    assert.equal(charged[0].n, 1, 'charged once, 6 tokens, before the model ran');

    const { extractions } = await gateway.call(listExtractions, { params: { siloId: silo.id }, query: { fileId: file.id } }, rc.cell.as(rc.root));
    assert.equal(extractions.length, 1);
    const flag = await gateway.call(getExtraction, { params: { siloId: silo.id, extractionId: extractions[0]!.id } }, rc.cell.as(rc.root));
    assert.deepEqual([flag.value, flag.method, flag.modelScore, flag.location, flag.filename], ['Late delivery', 'inferred', 0.82, 'line 2', 'note.txt']);
    const row = bq.table(importTableOf('Notes'))!.appended[0]!;
    assert.deepEqual([row['subject__method'], row['subject__extraction_id']], ['inferred', flag.id]);

    // Mapped to an object type, the object view flags the value as extracted, with its method, document, location and score (34.3).
    const { rows: [siloRow] } = await sql('select source_connection_id from siloes.siloes where id = $1', [silo.id]);
    const connectionId = siloRow.source_connection_id as string;
    const branch = await gateway.call(openBranch, { body: { name: 'notes' } }, rc.keyed(rc.editor));
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'filed_note' }, body: {
      displayName: 'Filed note', pluralName: 'Filed notes', contributingObjects: [{ connectionId, sourceObject: 'notes', identifierFieldPath: 'row_ref' }],
      properties: [
        { apiName: 'note_ref', displayName: 'Reference', dataType: 'string', mappings: [{ connectionId, sourceObject: 'notes', fieldPath: 'row_ref' }] },
        { apiName: 'subject', displayName: 'Subject', dataType: 'string', mappings: [{ connectionId, sourceObject: 'notes', fieldPath: 'subject' }] },
      ],
      primaryKey: 'note_ref', title: 'subject',
    } as never }, rc.keyed(rc.editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Notes' } }, rc.keyed(rc.editor));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, rc.cell.as(rc.root));
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, rc.keyed(rc.root));
    const noteType = (await gateway.call(getManifest, { query: {} }, rc.cell.as(rc.root))).objectTypes.find((t) => t.apiName === 'filed_note')!;
    const flagOf = async () => {
      const out = await gateway.call(readObjectView, { body: { objectTypeId: noteType.id, object: { connectionId, reference: 'p1' } } }, rc.cell.as(rc.root));
      assert.equal(out.outcome, 'object', JSON.stringify(out));
      const view = (out as { view: { title: unknown; properties: { apiName: string; readings: { value: unknown; extraction: unknown }[] }[] } }).view;
      assert.equal(view.title, 'Late delivery');
      const subject = view.properties.find((p) => p.apiName === 'subject')!.readings[0]!;
      assert.equal(subject.value, 'Late delivery');
      assert.equal(view.properties.find((p) => p.apiName === 'note_ref')!.readings[0]!.extraction, null, 'a row reference is no extraction');
      return subject.extraction;
    };
    assert.deepEqual(await flagOf(), {
      siloId: silo.id, extractionId: flag.id, method: 'inferred', document: 'note.txt', location: 'line 2', modelScore: 0.82, confirmed: false,
    });

    const confirmed = await gateway.call(confirmExtraction, { params: { siloId: silo.id, extractionId: flag.id } }, rc.cell.as(rc.root));
    assert.deepEqual([confirmed.method, confirmed.confirmedBy], ['certain', rc.root.membershipId]);
    assert.equal(bq.table(importTableOf('Notes'))!.appended[0]!['subject__method'], 'certain');
    assert.equal((await events('extraction_confirmed')).length, 1);
    assert.deepEqual(await flagOf(), {
      siloId: silo.id, extractionId: flag.id, method: 'certain', document: 'note.txt', location: 'line 2', modelScore: 0.82, confirmed: true,
    }, 'confirmed by a person: certain, and still traceable to its document');
    silo = await gateway.call(getSilo, { params: { siloId: silo.id } }, rc.cell.as(rc.root));
    assert.match(silo.disclosure, /sent to a language model/);
  });

  test('moved to another cell (6.4; D212): left, its dataset goes; arrived, its rows are rebuilt from its files and stored extractions, no model, nothing charged', async () => {
    const dataset = silo.store!;
    const tenantMigrations = rc.cell.client('tenant-migrations');
    const asOrganisation = { request: { organisationId: rc.cell.org } };
    const notesBefore = bq.table(importTableOf('Notes'))!.appended.length;
    const released = await tenantMigrations.call(releaseMovedSiloes, {}, asOrganisation);
    assert.ok(released.importDatasets >= 1);
    assert.ok(![...bq.tables.keys()].some((k) => k.startsWith(`${dataset}.`)), 'the cell it left holds none of its rows');
    const modelCalls = rc.modelRequests.length;
    const { rows: [before] } = await sql('select count(*)::int as n from billing.token_transactions');
    const adopted = await tenantMigrations.call(adoptMovedSiloes, {}, asOrganisation);
    assert.ok(adopted.importSilos >= 1 && adopted.files >= 2 && adopted.rows >= 2, JSON.stringify(adopted));
    const notes = bq.table(importTableOf('Notes'))!.appended;
    assert.equal(notes.length, notesBefore, 'every row back, once');
    assert.deepEqual([notes[0]!['subject'], notes[0]!['subject__method']], ['Late delivery', 'certain'], 'the confirmed value stays confirmed');
    assert.equal(rc.modelRequests.length, modelCalls, 'no model asked again');
    const { rows: [after] } = await sql('select count(*)::int as n from billing.token_transactions');
    assert.equal(after.n, before.n, 'nothing charged again');
  });

  test('a document draft (68.3): the model proposes fields by their label, structure only; the draft is probed on the same document; refused, not repaired', async () => {
    const loose = await gateway.call(createSource, { params: { siloId: silo.id }, body: { kind: 'upload' } }, rc.cell.as(rc.root));
    const file = await upload('invoice.txt', 'Invoice number: INV-7\nSupplier: Acme Ltd\nTotal: 120.50\n', loose.id);
    const asked = rc.modelRequests.length;
    rc.modelReplies.push({ objects: [{ name: 'Invoice', identifier: 'invoice_number', fields: [
      { name: 'invoice_number', type: 'string', label: 'Invoice number' }, { name: 'supplier', type: 'string', label: 'Supplier' },
      { name: 'total', type: 'decimal', label: 'Total' }, { name: 'summary', type: 'string', instruction: 'What the invoice is for' },
    ] }] });
    rc.modelReplies.push({ rows: [{ object: 'Invoice', fields: { invoice_number: { value: 'INV-7' }, supplier: { value: 'Acme Ltd' }, total: { value: '120.50' } } }] });
    const draft = await gateway.call(draftDefinition, { params: { siloId: silo.id }, body: { fileId: file.id } }, rc.cell.as(rc.root));
    assert.deepEqual(draft.document.objects[0]!.fields.map((f) => [f.name, f.extraction.kind]),
      [['invoice_number', 'label'], ['supplier', 'label'], ['total', 'label'], ['summary', 'prose']]);
    assert.deepEqual(draft.probe.fields.map((f) => [f.field, f.present]), [['invoice_number', 1], ['supplier', 1], ['total', 1], ['summary', 0]]);
    assert.deepEqual([draft.probe.rows, draft.probe.identifierUnique], [1, true]);
    assert.equal(rc.modelRequests.length - asked, 2, 'proposed, then probed');
    assert.match(JSON.stringify(rc.modelRequests[asked]!.body), /structure only/);
    assert.ok(!JSON.stringify(draft).includes('Acme'), 'the answer holds names, types and counts, never a value');

    rc.modelReplies.push({ objects: [{ name: 'Invoice', fields: [{ name: 'Not A Name', type: 'string', label: 'x' }] }] });
    await assert.rejects(gateway.call(draftDefinition, { params: { siloId: silo.id }, body: { fileId: file.id } }, rc.cell.as(rc.root)), { code: 'import.draft_invalid' });
  });

  test('the prebuilt catalogue (68.3): structure only; published as the catalogue holds it, or through the builder', async () => {
    const { definitions } = await gateway.call(listPrebuiltDefinitions, {}, rc.cell.as(rc.root));
    const byKey = new Map(definitions.map((d) => [d.key, d]));
    assert.deepEqual([byKey.get('invoice')!.requiresModel, byKey.get('bank_statement')!.requiresModel], [true, false]);
    const statement = byKey.get('bank_statement')!;
    const published = await gateway.call(publishDefinition, { params: { siloId: silo.id }, body: { route: 'prebuilt', prebuilt: 'bank_statement', document: statement.document } },
      rc.cell.as(rc.root));
    assert.equal(published.route, 'prebuilt');
    const changed = { objects: [{ ...statement.document.objects[0]!, name: 'My transactions' }] };
    await assert.rejects(gateway.call(publishDefinition, { params: { siloId: silo.id }, body: { route: 'prebuilt', prebuilt: 'bank_statement', document: changed } },
      rc.cell.as(rc.root)), { code: 'import.prebuilt_changed' });
    await assert.rejects(gateway.call(publishDefinition, { params: { siloId: silo.id }, body: { route: 'prebuilt', document: statement.document } as never }, rc.cell.as(rc.root)));
    assert.equal((await events('silo_definition_published')).at(-1)!['prebuilt'], 'bank_statement');
  });

  test('a watched location takes in what is dropped there', async () => {
    const watched = await gateway.call(createSource, { params: { siloId: silo.id }, body: { kind: 'watched', definitionId, pollIntervalMinutes: 5 } },
      rc.cell.as(rc.root));
    await store.put('siloes', `${watched.location}/drop-1.csv` as ObjectKey, Buffer.from(csv.replace(/INV-/g, 'W-')), 'text/csv');
    const file = await until('the dropped file', async () => {
      const { files } = await gateway.call(listFiles, { params: { siloId: silo.id } }, rc.cell.as(rc.root));
      return files.find((f) => f.sourceId === watched.id);
    });
    assert.equal(file.filename, 'drop-1.csv');
    assert.equal((await processed(file.id)).status, 'processed');
    assert.equal(store.keys('siloes').some((k) => k.includes('/drop/')), false, 'taken from the drop point');
    // Listed with its Silo's sources, with where to drop files and how often it is read (D271).
    const { sources } = await gateway.call(listSources, { params: { siloId: silo.id } }, rc.cell.as(rc.root));
    assert.deepEqual(sources.filter((x) => x.id === watched.id).map((x) => [x.kind, x.location, x.pollIntervalMinutes]), [['watched', watched.location, 5]]);
  });

  test('the organisation export carries captured transitions, imported files and their extractions, in their formats and Parquet (spec 2.6)', async () => {
    // A change since the entity purge, so there is a transition to carry.
    const other = SUPPLIERS.find((x) => x.id === 's02')!;
    const was = other.rating;
    other.rating = 12;
    try {
      await askSuppliers(['rating']);
      await until('a transition', async () => ((await sql('select count(*)::int as n from siloes.transitions')).rows[0].n > 0 ? true : undefined));
    } finally {
      other.rating = was;
    }
    const asked = await gateway.call(requestOrgExport, {}, rc.cell.as(rc.root));
    const done = await until('the export', async () => {
      const e = await gateway.call(getOrgExport, { params: { exportId: asked.id } }, rc.cell.as(rc.root));
      return e.status === 'completed' || e.status === 'failed' ? e : undefined;
    });
    assert.equal(done.status, 'completed', done.failureCategory ?? '');
    const included = done.items.filter((i) => i.status === 'included');
    const bundleKey = store.keys('files').find((k) => k.endsWith(`exports/${asked.id}/bundle.tar.gz`))!;
    const files = new Map(readTar(gunzipSync(await store.get('files', bundleKey as ObjectKey))).map((f) => [f.path, f.body]));
    const one = (family: string, format: string) => included.find((i) => i.family === family && i.format === format);

    // Captured transitions: the values opened, as JSON Lines and the same rows in Parquet.
    const transitions = one('siloes_transitions', 'jsonl')!;
    const lines = files.get(transitions.path!)!.toString().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(lines.length > 0 && lines.every((l) => 'new_value' in l && l['new_value'] !== undefined));
    const parquet = files.get(one('siloes_transitions', 'parquet')!.path!)!;
    const rows = await parquetReadObjects({ file: parquet.buffer.slice(parquet.byteOffset, parquet.byteOffset + parquet.length) as ArrayBuffer });
    assert.equal(rows.length, lines.length);

    // Imported files as they came, and their extractions with the values opened.
    const original = one('siloes_imports', 'original')!;
    assert.ok(files.get(original.path!)!.length > 0);
    const extractions = files.get(one('siloes_imports', 'jsonl')!.path!)!.toString().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(extractions.length > 0 && extractions.every((x) => x['value'] !== undefined && typeof x['value'] !== 'string' || !String(x['value']).startsWith('\\x')));
    assert.ok(one('siloes_imports', 'parquet'));
  });

  test('purge file removes the file itself, its rows and its extracted values, with a receipt', async () => {
    const { files } = await gateway.call(listFiles, { params: { siloId: silo.id } }, rc.cell.as(rc.root));
    const note = files.find((f) => f.filename === 'note.txt')!;
    const asked = await gateway.call(requestPurge, { params: { siloId: silo.id }, body: { scope: 'file', fileId: note.id } }, rc.cell.as(rc.root));
    const done = await purged(silo.id, asked.id);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(store.keys('siloes').some((k) => k.endsWith(note.id)), false, 'the source document is gone, not only its rows');
    assert.equal(bq.table(importTableOf('Notes'))!.appended.length, 0);
    assert.deepEqual([done.receipt!.removed['gcs'], done.receipt!.removed['postgres']], [{ files: 1, bytes: note.sizeBytes }, { extractions: 1 }]);
    assert.equal((await sql('select status from siloes.silo_files where id = $1', [note.id])).rows[0].status, 'purged');
    assert.equal((await events('silo_import_purged')).length, 1);
  });
});

// ----------------------------------------------------------------------------- retention, approval, disable

describe('retention, approval and disable (spec 70)', () => {
  let purge: PurgeView;

  test('the sweep enforces each window and audits what it removed', async () => {
    ahead = 400 * DAY;
    try {
      const { siloes } = await rc.cell.client('admin-portal').call(runRetentionSweep, {}, rc.cell.as(rc.root));
      const importSwept = siloes.find((s) => s.kind === 'import')!;
      assert.ok(importSwept.counts['files']! >= 2, JSON.stringify(siloes));
      const captureSwept = siloes.find((s) => s.kind === 'capture')!;
      assert.ok(captureSwept.counts['baselines']! > 0);
      assert.ok((await events('retention_swept')).length >= 2);
      assert.equal(store.keys('siloes').filter((k) => k.includes('/files/')).length, 0);
    } finally {
      ahead = 0;
    }
  });

  test('where a default approval policy exists, a wipe waits for an approver holding silo.purge', async () => {
    await gateway.call(createApprovalPolicy, { body: { connectionId: null, approvalsRequired: 1 } }, rc.cell.as(rc.root));
    const { rows } = await sql(`select id from siloes.siloes where kind = 'capture'`);
    const siloId = rows[0].id as string;
    purge = await gateway.call(requestPurge, { params: { siloId }, body: { scope: 'concept', objectTypeId: rc.type('supplier').id } }, rc.cell.as(rc.root));
    assert.equal(purge.status, 'awaiting_approval');
    assert.ok(purge.approvalChainId !== null && purge.documentHash !== null);
    await assert.rejects(gateway.call(decideApproval, { params: { chainId: purge.approvalChainId! }, body: { decision: 'approved', diffHash: purge.documentHash! } },
      rc.cell.as(rc.root)), 'the requester never approves their own wipe');
    const chain = await gateway.call(decideApproval, { params: { chainId: purge.approvalChainId! }, body: { decision: 'approved', diffHash: purge.documentHash! } },
      rc.cell.as(rc.editor));
    assert.deepEqual(chain.subject, { kind: 'purge', id: purge.id, siloId }, 'the chain names the purge and its Silo (D264)');
    const done = await purged(siloId, purge.id);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.ok((await events('purge_approved')).some((d) => String(d['approvers']).includes(rc.editor.membershipId)));
  });

  test('disable and purge is one action; Siloes switch off only when none is left', async () => {
    await assert.rejects(gateway.call(setSiloesEnabled, { body: { enabled: false } }, rc.cell.as(rc.root)), { code: 'siloes.siloes_remaining' });
    const { rows } = await sql('select id, kind from siloes.siloes where disabled_at is null');
    for (const s of rows as { id: string; kind: string }[]) {
      const asked = await gateway.call(requestPurge, { params: { siloId: s.id }, body: { scope: 'silo' } }, rc.cell.as(rc.root));
      await gateway.call(decideApproval, { params: { chainId: asked.approvalChainId! }, body: { decision: 'approved', diffHash: asked.documentHash! } },
        rc.cell.as(rc.editor));
      const done = await purged(s.id, asked.id);
      assert.equal(done.status, 'completed', JSON.stringify(done));
    }
    const left = await sql('select status, disabled_at from siloes.siloes');
    assert.ok(left.rows.every((r) => r.status === 'disabled' && r.disabled_at !== null));
    const sources = await sql(`select c.status from siloes.siloes s join connect.connections c on c.id = s.source_connection_id where s.kind = 'import'`);
    assert.ok(sources.rows.length > 0 && sources.rows.every((r) => r.status === 'revoked'), 'an Import Silo\'s source connection answers no more (66.5)');
    assert.equal((await gateway.call(setSiloesEnabled, { body: { enabled: false } }, rc.cell.as(rc.root))).enabled, false);
    assert.equal((await events('silo_disabled')).length, 1);
  });

  test('a marking on the Silo refuses an upload from someone without clearance', async () => {
    // Switched back on for this check only.
    await gateway.call(setSiloesEnabled, { body: { enabled: true } }, rc.cell.as(rc.root));
    const silo = await gateway.call(createImportSilo, { body: { name: 'Restricted', purpose: 'Marked files', retentionDays: 30 } }, rc.keyed(rc.root));
    const source = await gateway.call(createSource, { params: { siloId: silo.id }, body: { kind: 'upload' } }, rc.cell.as(rc.root));
    const marking = (await gateway.call(createMarking, { body: { name: 'Import restricted', kind: 'compartment' } }, rc.cell.as(rc.root))).id;
    await gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'silo', id: silo.id } } }, rc.cell.as(rc.root));
    await assert.rejects(gateway.call(uploadFile, {
      params: { siloId: silo.id, sourceId: source.id }, body: { filename: 'plan.png', contentClass: 'site_plan', contentBase64: Buffer.from('\x89PNG....').toString('base64') },
    }, rc.keyed(rc.root)), { code: 'import.not_cleared' });
  });
});
