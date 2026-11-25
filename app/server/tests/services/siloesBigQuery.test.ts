// Siloes in Silo's own BigQuery, beyond the Warehouse core: Import rows (spec 68.4, 68.6),
// the Object Index (69.1 to 69.11) and search routed to it, BigQuery metering (69.7, 74.1),
// and Warehouse direct access and exit (69.16, 69.17). BigQuery is the in-memory fake
// (warehouse.helper.ts); everything else runs as real services.

import { applyIndexObservations } from '../../src/contracts/index-builder/observations.contract.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { measureBigQuery } from '../../src/contracts/bigquery-metering/metering.contract.ts';
import { confirmImportValues, dropImportDataset, loadImportRows, purgeImportFile } from '../../src/contracts/import-loader/load.contract.ts';
import {
  addIndexType, changeIndexProperties, createObjectIndex, getObjectIndex, rebuildIndexType, removeIndexType, type ObjectIndexView,
  objectIndexCoverage, readObjectIndex,
} from '../../src/contracts/index-builder/index.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { searchObjects } from '../../src/contracts/search/search.contract.ts';
import { runPlan } from '../../src/contracts/executor/result.contract.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import {
  exportWarehouse, grantWarehouseSqlAccess, handOverWarehouse, listWarehouseSqlGrants, revokeWarehouseSqlAccess,
} from '../../src/contracts/warehouse/access.contract.ts';
import { createWarehouse, getWarehouse, syncWarehouse, type WarehouseView } from '../../src/contracts/warehouse/warehouse.contract.ts';
import { labelValue } from '../../src/infra/bigquery.infra.ts';
import type { ObjectKey } from '../../src/infra/objectStorage.infra.ts';
import { createBigQueryMeteringService } from '../../src/routes/bigquery-metering/index.route.ts';
import { createImportLoaderService } from '../../src/routes/import-loader/index.route.ts';
import { createIndexBuilderService } from '../../src/routes/index-builder/index.route.ts';
import { getOrgExport, requestOrgExport } from '../../src/contracts/org-export/export.contract.ts';
import { createOrgExportService } from '../../src/routes/org-export/index.route.ts';
import { readTar } from '../../src/utils/tar.util.ts';
import { gunzipSync } from 'node:zlib';
import { service as searchService } from '../../src/routes/search/index.route.ts';
import { createWarehouseAccessService } from '../../src/routes/warehouse-access/index.route.ts';
import { createWarehouseProvisionerService } from '../../src/routes/warehouse-provisioner/index.route.ts';
import { createWarehouseSchemaService } from '../../src/routes/warehouse-schema/index.route.ts';
import { createWarehouseSyncService } from '../../src/routes/warehouse-sync/index.route.ts';
import { computeCost, micros, pounds, storageCost, windowsAfter } from '../../src/services/bigquery-metering/metering.service.ts';
import { importTableOf } from '../../src/services/import-loader/loader.service.ts';
import { indexTableOf } from '../../src/services/index-builder/index.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { ORDERS, startRecognitionCell, SUPPLIERS, type RecognitionCell } from './recognition.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { createFakeBigQuery, type FakeBigQuery } from './warehouse.helper.ts';

let rc: RecognitionCell;
let bq: FakeBigQuery;
let gateway: RecognitionCell['gateway'];
const memory = createMemoryStore();
const store = memory;
const objects = { get: (key: ObjectKey) => memory.objects.get(`files:${key}`)?.body };
const DAY = 86_400_000;
const WRITERS = ['serviceAccount:siloes-import@silo-test-proj.iam.gserviceaccount.com'];

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
const auditEvents = async (prefix: string) => new Set((await sql(
  `select payload ->> 'event' as event from platform.outbox where organisation_id = $1 and payload ->> 'event' like $2`, [rc.cell.org, `${prefix}%`],
)).rows.map((r) => r.event as string));

before(async () => {
  rc = await startRecognitionCell([]);
  // Siloes are off until a super admin switches them on (spec 66.6).
  await sql('update iam.organisations set storage_enabled = true where id = $1', [rc.cell.org]);
  bq = createFakeBigQuery();
  const env = {
    BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', WAREHOUSE_WRITER_MEMBERS: WRITERS.join(','),
    BIGQUERY_PRICE_PER_TIB_SCANNED: '5.00', BIGQUERY_PRICE_PER_GIB_MONTH_STORED: '0.02', IMPORT_LOADER_MAX_ROWS: '5',
    OBJECT_INDEX_TICK_SECONDS: '1', WAREHOUSE_ACCESS_CHECK_SECONDS: '1',
  };
  await rc.cell.start(createImportLoaderService({ bigQuery: bq }), 'import-loader', 'test_app', env);
  await rc.cell.start(createIndexBuilderService({ bigQuery: bq }), 'index-builder', 'test_app', env);
  // After the index builder, so search knows where to ask; and an executor that knows it too,
  // for the plans the Object Index answers (69.6).
  await rc.cell.start(searchService, 'search', 'test_app');
  await rc.cell.start(executorService, 'executor', 'test_app', { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: '50', EXECUTOR_MAX_RESULT_ROWS: '1000' });
  await rc.cell.start(createBigQueryMeteringService({ bigQuery: bq, schedule: false, now: () => Date.now() + 2 * DAY }), 'bigquery-metering', 'test_app', env);
  await rc.cell.start(createWarehouseSchemaService({ bigQuery: bq }), 'warehouse-schema', 'test_app', env);
  await rc.cell.start(createWarehouseSyncService({ bigQuery: bq, schedule: false }), 'warehouse-sync', 'test_app', env);
  await rc.cell.start(createWarehouseProvisionerService({ bigQuery: bq }), 'warehouse-provisioner', 'test_app', env);
  await rc.cell.start(createWarehouseAccessService({ bigQuery: bq, store, filesBucket: 'silo-test-files' }), 'warehouse-access', 'test_app', env);
  await rc.cell.start(createOrgExportService({ objects: store }), 'org-export', 'test_app', {
    OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
    ORG_EXPORT_TICK_SECONDS: '1',
  });
  gateway = rc.cell.client('gateway');
});

after(async () => {
  await rc?.close();
});

// ----------------------------------------------------------------------------- Import rows

describe('Import rows (spec 68.4, 68.6)', () => {
  const siloId = uuidv7();
  const fileId = uuidv7();
  const receivedAt = '2026-11-01T10:00:00.000000Z';
  const dataset = `imp_test_${siloId.replaceAll('-', '').slice(-12)}`;
  const loader = () => rc.cell.client('siloes-import');
  const fields = [
    { name: 'supplier_name', type: 'string' as const },
    { name: 'amount', type: 'decimal' as const, extracted: true },
    { name: 'invoiced', type: 'date' as const },
  ];
  const body = (rows: { rowRef: string; values: Record<string, string | number | null>; extraction?: Record<string, { method: 'near' | 'inferred'; extractionId: string }> }[],
    definitionVersion = 1) => ({ siloId, fileId, definitionVersion, receivedAt, object: 'Invoices', fields, rows, markingIds: [] });
  const rows = () => bq.table(importTableOf('Invoices'))!.appended;

  before(async () => {
    const sourceId = uuidv7();
    await sql(`insert into siloes.siloes (id, organisation_id, kind, name, purpose, retention_days, location, status, store_ref, created_by)
               values ($1, $2, 'import', 'Invoices archive', 'Old invoices', 365, 'europe-west2', 'provisioning', $3, $4)`,
    [siloId, rc.cell.org, dataset, rc.root.membershipId]);
    await sql(`insert into siloes.silo_sources (id, organisation_id, silo_id, kind, location, created_by) values ($1, $2, $3, 'upload', $4, $5)`,
      [sourceId, rc.cell.org, siloId, `silo/${siloId}/drop/${sourceId}/`, rc.root.membershipId]);
    await sql(`insert into siloes.silo_files (id, organisation_id, silo_id, source_id, object_store_key, filename, size_bytes, content_type,
                                              content_class, received_at)
               values ($1, $2, $3, $4, $5, 'invoices.pdf', 100, 'application/pdf', 'structured', $6)`,
    [fileId, rc.cell.org, siloId, sourceId, `silo/${siloId}/files/${fileId}`, receivedAt]);
  });

  test('a load makes the table, keeps each value\'s method, and a retry replays the job', async () => {
    const extractionId = uuidv7();
    const key = { ...rc.cell.as(rc.root), idempotencyKey: uuidv7() };
    const request = {
      body: body([
        { rowRef: 'r1', values: { supplier_name: 'Acme Ltd', amount: '120.50', invoiced: '2026-10-01' } },
        { rowRef: 'r2', values: { supplier_name: 'Brill plc', amount: 99, invoiced: null }, extraction: { amount: { method: 'inferred', extractionId } } },
        { rowRef: 'r3', values: { supplier_name: 'Cobalt', amount: null, invoiced: '2026-10-03' } },
      ]),
    };
    const loaded = await loader().call(loadImportRows, request, key);
    assert.equal(loaded.table, 'obj__invoices');
    assert.equal(loaded.dataset, dataset);
    assert.equal(loaded.rowsLoaded, 3);
    assert.equal(loaded.replayed, false);
    assert.equal(bq.datasets.get(`silo-test-proj.${dataset}`)?.maxTimeTravelHours, 48);
    const columns = bq.table('obj__invoices')!.columns.map((c) => c.name);
    for (const c of ['_row_ref', '_file_id', '_silo_id', '_definition_version', '_received_at', '_loaded_at', '_marking_ids', 'amount__method', 'amount__extraction_id']) {
      assert.ok(columns.includes(c), c);
    }
    assert.ok(!columns.includes('supplier_name__method'), 'only extracted fields carry a method');
    assert.deepEqual(rows().map((r) => [r['_row_ref'], r['amount__method'], r['amount__extraction_id'] ?? null]),
      [['r1', 'certain', null], ['r2', 'inferred', extractionId], ['r3', 'certain', null]]);
    assert.ok(bq.statements.some((s) => s.text.includes('require_partition_filter = true')));

    const again = await loader().call(loadImportRows, request, key);
    assert.equal(again.replayed, true);
    assert.equal(again.jobId, loaded.jobId);
    assert.equal(rows().length, 3);
  });

  test('a value of the wrong type is refused by row and field, never quoting the value; a load is bounded', async () => {
    await assert.rejects(loader().call(loadImportRows, { body: body([{ rowRef: 'r9', values: { amount: 'secret-figure' } }]) }, rc.keyed(rc.root)),
      (error: { code: string; message: string; details: Record<string, unknown> }) => {
        assert.equal(error.code, 'import.value_type');
        assert.deepEqual([error.details['row'], error.details['field']], [0, 'amount']);
        assert.ok(!JSON.stringify(error).includes('secret-figure'));
        return true;
      });
    const many = Array.from({ length: 6 }, (_, i) => ({ rowRef: `m${i}`, values: {} }));
    await assert.rejects(loader().call(loadImportRows, { body: body(many) }, rc.keyed(rc.root)), { code: 'import.too_many_rows' });
  });

  test('another part of the file keeps the first; a new definition version replaces the file\'s rows', async () => {
    await loader().call(loadImportRows, { body: body([{ rowRef: 'r4', values: { supplier_name: 'Delta' } }]) }, rc.keyed(rc.root));
    assert.deepEqual(rows().map((r) => r['_row_ref']).sort(), ['r1', 'r2', 'r3', 'r4']);
    await loader().call(loadImportRows, {
      body: body([{ rowRef: 'r1', values: { supplier_name: 'Acme Ltd', amount: '121' }, extraction: { amount: { method: 'near', extractionId: uuidv7() } } }], 2),
    }, rc.keyed(rc.root));
    assert.deepEqual(rows().map((r) => [r['_row_ref'], r['_definition_version'], r['amount__method']]), [['r1', 2, 'near']]);
  });

  test('a confirmed value becomes certain; purging the file deletes its rows; purging the Silo drops the dataset', async () => {
    const confirmed = await loader().call(confirmImportValues, {
      body: { siloId, fileId, receivedAt, object: 'Invoices', confirmations: [{ rowRef: 'r1', field: 'amount' }] },
    }, rc.cell.as(rc.root));
    assert.equal(confirmed.rowsUpdated, 1);
    assert.equal(rows()[0]!['amount__method'], 'certain');
    await assert.rejects(loader().call(confirmImportValues, {
      body: { siloId, fileId, receivedAt, object: 'Invoices', confirmations: [{ rowRef: 'r1', field: 'supplier_name' }] },
    }, rc.cell.as(rc.root)), { code: 'import.not_extracted' });

    const purged = await loader().call(purgeImportFile, { params: { fileId }, body: { siloId, receivedAt } }, rc.cell.as(rc.root));
    assert.deepEqual(purged, { tables: 1, rowsDeleted: 1 });
    assert.equal(rows().length, 0);
    const dropped = await loader().call(dropImportDataset, { body: { siloId } }, rc.cell.as(rc.root));
    assert.deepEqual(dropped, { dataset, dropped: true });
    assert.equal(bq.datasets.has(`silo-test-proj.${dataset}`), false);
  });
});

// ----------------------------------------------------------------------------- the Object Index

describe('the Object Index (spec 69.1 to 69.11)', () => {
  let index: ObjectIndexView;
  let definitionId: string;
  const entries = () => bq.table(indexTableOf(definitionId))!;
  const latestRefresh = async (after?: string) => until('a refresh to finish', async () => {
    const view = await gateway.call(getObjectIndex, { params: { siloId: index.id } }, rc.cell.as(rc.root));
    const last = view.definitions.find((d) => d.id === definitionId)?.lastRefresh;
    return last && last.status !== 'running' && (after === undefined || last.id !== after) ? last : undefined;
  });
  const search = (text: string) => gateway.call(searchObjects, { body: { text, objectTypeIds: [rc.type('supplier').id] } as never }, rc.cell.as(rc.root));

  test('only silo.create holders create one; it is a Silo with its own principal and dataset', async () => {
    await assert.rejects(gateway.call(createObjectIndex, { body: { name: 'Index', purpose: 'Search', retentionDays: 90 } }, rc.keyed(rc.viewer)),
      { code: 'index.not_permitted' });
    index = await gateway.call(createObjectIndex, { body: { name: 'Supplier index', purpose: 'Find suppliers fast', retentionDays: 90 } }, rc.keyed(rc.root));
    assert.equal(index.status, 'provisioning');
    assert.match(index.dataset, /^idx_[0-9a-f]{12}_[0-9a-f]{12}$/);
    assert.equal(bq.datasets.get(`silo-test-proj.${index.dataset}`)?.maxTimeTravelHours, 48);
    const { rows } = await sql('select service_principal_id from siloes.siloes where id = $1', [index.id]);
    assert.ok(rows[0].service_principal_id);
  });

  test('a nomination holds its properties and nothing else, built at once', async () => {
    await assert.rejects(gateway.call(addIndexType, {
      params: { siloId: index.id }, body: { objectTypeId: rc.type('supplier').id, properties: ['name', 'colour'], refreshSchedule: '0 * * * *' },
    }, rc.cell.as(rc.root)), { code: 'index.unknown_property' });
    const added = await gateway.call(addIndexType, {
      params: { siloId: index.id }, body: { objectTypeId: rc.type('supplier').id, properties: ['name', 'region'], refreshSchedule: '0 * * * *' },
    }, rc.cell.as(rc.root));
    definitionId = added.id;
    assert.ok(added.nextRefreshAt !== null && Date.parse(added.nextRefreshAt) > Date.now());
    const done = await latestRefresh();
    assert.equal(done.status, 'completed', JSON.stringify(done));
    await assert.rejects(gateway.call(addIndexType, {
      params: { siloId: index.id }, body: { objectTypeId: rc.type('supplier').id, properties: ['name'], refreshSchedule: '0 * * * *' },
    }, rc.cell.as(rc.root)), { code: 'index.type_present' });
    const table = entries();
    assert.ok(table.rows.size > 0 && done.objectsWritten === table.rows.size);
    const names = table.columns.map((c) => c.name);
    assert.ok(names.includes('name') && names.includes('region') && names.includes('name__marking_ids'));
    assert.ok(!names.includes('rating') && !names.includes('email'), 'never a property that was not nominated');
    for (const row of table.rows.values()) assert.ok(typeof row['_refreshed_at'] === 'string' && Array.isArray(row['_connection_ids']));
  });

  test('the planner\'s read (69.6): coverage and watermark, filtered entries with their refresh time, keys as a semi-join', async () => {
    const supplier = rc.type('supplier').id;
    const region = rc.prop('supplier', 'region');
    const name = rc.prop('supplier', 'name');
    const coverage = await rc.cell.client('planner').call(objectIndexCoverage, { body: { objectTypeIds: [supplier] } }, rc.cell.as(rc.root));
    assert.deepEqual(coverage.types.map((t) => [t.objectTypeId, [...t.held].sort()]), [[supplier, [name, region].sort()]]);
    const executor = rc.cell.client('executor');
    const read = await executor.call(readObjectIndex, {
      body: { objectTypeId: supplier, properties: [name, region], filters: [{ property: region, op: 'eq', value: 'north' }], limit: 100 },
    }, rc.cell.as(rc.root));
    assert.equal(read.outcome, 'read');
    const rows = (read as { rows: { objectId: string; values: Record<string, unknown> }[]; refreshedAt: string }).rows;
    assert.ok(rows.length > 0 && rows.every((r) => r.values['region'] === 'north'));
    assert.equal((read as { refreshedAt: string }).refreshedAt, coverage.types[0]!.refreshedAt, 'stated as of the refresh');
    const keyed = await executor.call(readObjectIndex, {
      body: { objectTypeId: supplier, properties: [region], filters: [], keys: [rows[0]!.objectId], limit: 100 },
    }, rc.cell.as(rc.root));
    assert.deepEqual((keyed as { rows: { objectId: string }[] }).rows.map((r) => r.objectId), [rows[0]!.objectId]);
    const unheld = await executor.call(readObjectIndex, {
      body: { objectTypeId: supplier, properties: [rc.prop('supplier', 'rating')], filters: [], limit: 10 },
    }, rc.cell.as(rc.root));
    assert.deepEqual(unheld, { outcome: 'not_indexed', reason: 'not_indexed' }, 'a property not nominated is read live');
  });

  test('a type two systems feed is answered by the Index too: each value\'s state as decided, disputes as the engine counts them (69.6)', async () => {
    const supplier = rc.type('supplier').id;
    const name = rc.prop('supplier', 'name');
    const region = rc.prop('supplier', 'region');
    const executor = rc.cell.client('executor');
    const read = (filters: { property: string; op: 'eq' | 'is_null'; value?: string }[]) => executor.call(readObjectIndex, {
      body: { objectTypeId: supplier, properties: [name], filters, limit: 100 },
    }, rc.cell.as(rc.root)) as Promise<{ outcome: 'read'; excludedByDispute: number; rows: { values: Record<string, unknown>; states: Record<string, string> }[] }>;
    // The first five suppliers' names are disputed between the systems.
    const named = await read([{ property: name, op: 'eq', value: 'Foxtrot' }]);
    assert.deepEqual([named.rows.map((r) => r.values['name']), named.excludedByDispute], [['Foxtrot'], 5], 'the disputed names left out, counted');
    assert.equal(named.rows[0]!.states['name'], 'agreed', 'both systems hold Foxtrot');
    const empty = await read([{ property: name, op: 'is_null' }]);
    assert.deepEqual([empty.rows.length, empty.excludedByDispute], [0, 5], 'a disputed name is not an empty one');

    const run = await rc.cell.client('workspace').call(runPlan, {
      body: {
        plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id,
          nodes: [{ objectTypeId: supplier, filters: [{ property: region, op: 'eq', value: { param: 'p1' } }] }], hops: [],
          select: [{ node: 0, property: name }, { node: 0, property: region }], sort: [] },
        parameters: { p1: 'north' }, trigger: 'structured', useCache: false,
      },
    }, rc.cell.as(rc.root)) as { outcome: 'answer'; result: { page: { objects: { values: Record<string, unknown>; states: Record<string, string> }[] };
      lineage: { servedBy?: { kind: string } }[] } };
    assert.equal(run.outcome, 'answer');
    assert.ok(run.result.lineage.every((l) => l.servedBy?.kind === 'index'), 'answered by the Index');
    // North: Acme and Cobalt (names disputed), Foxtrot and Kilo (both systems agree).
    assert.deepEqual(run.result.page.objects.map((o) => [o.values['name'] ?? null, o.states['name']]).sort(),
      [[null, 'disputed'], [null, 'disputed'], ['Foxtrot', 'agreed'], ['Kilo', 'agreed']]);
  });

  test('Explorer\'s facet counts over indexed properties come from the fresh Index (69.3); any other aggregate reads the sources', async () => {
    const supplier = rc.type('supplier').id;
    const region = rc.prop('supplier', 'region');
    const facet = (trigger: 'explorer_facet' | 'structured') => rc.cell.client('workspace').call(runPlan, {
      body: {
        plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id, nodes: [{ objectTypeId: supplier, filters: [] }], hops: [], select: [],
          aggregate: { groupBy: [{ node: 0, property: region }], measures: [{ fn: 'count', node: 0, as: 'n' }] }, sort: [{ measure: 'n', direction: 'desc' }] },
        parameters: {}, trigger, useCache: false,
      },
    }, rc.cell.as(rc.root)) as Promise<{ outcome: 'answer'; result: { page: { groups: { key: Record<string, unknown>; measures: Record<string, unknown> }[] }; lineage: { servedBy?: { kind: string } }[] } }>;
    const counts = (r: Awaited<ReturnType<typeof facet>>) => r.result.page.groups.map((g) => [g.key['region'], Number(g.measures['n'])]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const served = await facet('explorer_facet');
    assert.equal(served.outcome, 'answer');
    assert.ok(served.result.lineage.some((l) => l.servedBy?.kind === 'index'), 'counted over the Index\'s entries');
    const live = await facet('structured');
    assert.ok(live.result.lineage.every((l) => l.servedBy?.kind !== 'index'), 'an aggregate that might feed a decision reads the sources (69.3)');
    assert.deepEqual(counts(served), counts(live), 'the same counts');
    assert.deepEqual(counts(served), [['east', 3], ['north', 4], ['south', 3], ['west', 2]]);
  });

  test('a filter on indexed properties of a single-source type is answered by the fresh Index, as of its refresh; otherwise live (69.6)', async () => {
    const order = rc.type('order').id;
    const added = await gateway.call(addIndexType, {
      params: { siloId: index.id }, body: { objectTypeId: order, properties: ['order_id', 'units'], refreshSchedule: '0 * * * *' },
    }, rc.cell.as(rc.root));
    await until('the order nomination to refresh', async () => {
      const view = await gateway.call(getObjectIndex, { params: { siloId: index.id } }, rc.cell.as(rc.root));
      const last = view.definitions.find((d) => d.id === added.id)?.lastRefresh;
      return last && last.status === 'completed' ? last : undefined;
    });
    const plan = (typeId: string, select: [string, string][], filter: [string, string, unknown]) => rc.cell.client('workspace').call(runPlan, {
      body: {
        plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id,
          nodes: [{ objectTypeId: typeId, filters: [{ property: rc.prop(filter[0], filter[1]), op: 'gte', value: { param: 'p1' } }] }],
          hops: [], select: select.map(([t, p]) => ({ node: 0, property: rc.prop(t, p) })), sort: [] },
        parameters: { p1: filter[2] as number }, trigger: 'structured', useCache: false,
      },
    }, rc.cell.as(rc.root));
    type Answer = { result: { page: { objects: { values: Record<string, unknown> }[] };
      lineage: { servedBy?: { kind: string; asOf: string }; narrowedBy?: { kind: string; asOf: string } }[] } };
    const indexed = (await plan(order, [['order', 'order_id'], ['order', 'units']], ['order', 'units', 3])) as Answer;
    assert.deepEqual(indexed.result.page.objects.map((o) => o.values['order_id']).sort(), ['o1', 'o2', 'o3'], 'units of three or more');
    assert.ok(indexed.result.lineage.every((l) => l.servedBy?.kind === 'index'), 'every figure says where it came from');
    const coverage = await rc.cell.client('planner').call(objectIndexCoverage, { body: { objectTypeIds: [order] } }, rc.cell.as(rc.root));
    assert.equal(indexed.result.lineage[0]!.servedBy!.asOf, coverage.types[0]!.refreshedAt, 'as of the refresh');
    // supplier_id is not indexed, and the system cannot filter on units but takes ids: a split plan,
    // the set from the index and the values read live by key.
    const wider = (await plan(order, [['order', 'order_id'], ['order', 'supplier_id']], ['order', 'units', 3])) as Answer;
    assert.ok(wider.result.lineage.every((l) => l.servedBy === undefined), 'values read live');
    assert.ok(wider.result.lineage.every((l) => l.narrowedBy?.kind === 'index' && l.narrowedBy.asOf === coverage.types[0]!.refreshedAt), 'the set as of the refresh');
    assert.deepEqual(wider.result.page.objects.map((o) => [o.values['order_id'], o.values['supplier_id']]).sort(),
      [['o1', 's01'], ['o2', 's01'], ['o3', 's02']], 'the same answer, values live');
    // An order that has stopped meeting the filter since the refresh: the live value leaves it out.
    const o2 = ORDERS.find((o) => o.id === 'o2')!;
    o2.units = 1;
    try {
      const since = (await plan(order, [['order', 'order_id'], ['order', 'supplier_id']], ['order', 'units', 3])) as Answer;
      assert.deepEqual(since.result.page.objects.map((o) => o.values['order_id']).sort(), ['o1', 'o3']);
    } finally {
      o2.units = 3;
    }
    await gateway.call(removeIndexType, { params: { siloId: index.id, definitionId: added.id } }, rc.cell.as(rc.root));
  });

  test('search is answered from the index, with its refresh time on every result', async () => {
    // The first five suppliers' names are disputed between the systems: held as null, never matched.
    assert.equal((await search('acme')).results.length, 0);
    const found = await search('golf');
    assert.equal(found.method, 'index');
    assert.equal(found.groups[0]!.route, 'index');
    assert.ok(found.groups[0]!.refreshedAt !== null);
    assert.ok(found.results.length > 0);
    for (const r of found.results) {
      assert.match(r.title ?? '', /golf/i);
      assert.ok(r.refreshedAt !== null, 'never presented as live');
      assert.deepEqual(r.sources, []);
    }
  });

  test('a change stream\'s value updates an existing entry and clears its hash for the next refresh; an object not indexed waits for it (69.4)', async () => {
    const [key, entry] = [...entries().rows.entries()][0]!;
    const out = await rc.cell.client('siloes-capture').call(applyIndexObservations, { body: { siloId: index.id, entries: [
      { objectTypeId: rc.type('supplier').id, objectRef: key, property: 'region', value: 'Moon', observedAt: new Date().toISOString(), connectionId: rc.crm },
      { objectTypeId: rc.type('supplier').id, objectRef: 'not-indexed', property: 'region', value: 'Mars', observedAt: new Date().toISOString(), connectionId: rc.crm },
      { objectTypeId: rc.type('supplier').id, objectRef: key, property: 'email', value: 'x', observedAt: new Date().toISOString(), connectionId: rc.crm },
    ] } }, { request: { organisationId: rc.cell.org }, correlationId: uuidv7() });
    assert.deepEqual([out.updated, out.skipped], [1, 1], 'one entry updated; a property not nominated skipped');
    const updated = entries().rows.get(key)!;
    assert.deepEqual([updated['region'], updated['_row_hash'], updated['_refreshed_at']], ['Moon', null, entry['_refreshed_at']]);
    assert.equal(entries().rows.has('not-indexed'), false);
  });

  test('an entry carrying a marking the reader lacks is never matched; clearance brings it back', async () => {
    const restricted = (await gateway.call(createMarking, { body: { name: 'Index restricted', kind: 'compartment' } }, rc.cell.as(rc.root))).id;
    await gateway.call(applyMarking, { body: { markingId: restricted, resource: { type: 'silo', id: index.id } } }, rc.cell.as(rc.root));
    const before = (await latestRefresh()).id;
    await gateway.call(rebuildIndexType, { params: { siloId: index.id, definitionId } }, rc.cell.as(rc.root));
    assert.equal((await latestRefresh(before)).status, 'completed');
    for (const row of entries().rows.values()) assert.deepEqual(row['_marking_ids'], [restricted]);

    const hidden = await search('golf');
    assert.equal(hidden.groups[0]!.route, 'index');
    assert.equal(hidden.results.length, 0, 'no hit count reveals a value the reader may not see');
    await gateway.call(grantClearance, { body: { markingId: restricted, holder: { kind: 'membership', id: rc.root.membershipId } } }, rc.cell.as(rc.root));
    assert.ok((await search('golf')).results.length > 0);
  });

  test('the organisation export carries the index\'s entries, markings and all, as JSON Lines and Parquet (spec 2.6)', async () => {
    const asked = await gateway.call(requestOrgExport, {}, rc.cell.as(rc.root));
    let done: Awaited<ReturnType<typeof gateway.call<typeof getOrgExport>>> | undefined;
    for (let i = 0; i < 100 && (done === undefined || !['completed', 'failed'].includes(done.status)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      done = await gateway.call(getOrgExport, { params: { exportId: asked.id } }, rc.cell.as(rc.root));
    }
    assert.equal(done?.status, 'completed', done?.failureCategory ?? '');
    const index = done!.items.filter((i) => i.family === 'siloes_index' && i.artefact.startsWith('index:'));
    assert.deepEqual(index.map((i) => [i.status, i.format]).sort(), [['included', 'jsonl'], ['included', 'parquet']], 'cleared, so included');
    const bundleKey = store.keys('files').find((k) => k.endsWith(`exports/${asked.id}/bundle.tar.gz`))!;
    const files = new Map(readTar(gunzipSync(await store.get('files', bundleKey as never))).map((f) => [f.path, f.body]));
    const lines = files.get(index.find((i) => i.format === 'jsonl')!.path!)!.toString().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, entries().rows.size);
    assert.ok(lines.every((l) => Array.isArray(l['_marking_ids'])), 'each entry keeps its markings');
  });

  test('a property the nominator cannot see cannot be nominated; a change is audited with both lists', async () => {
    const hr = (await gateway.call(createMarking, { body: { name: 'Contact details', kind: 'compartment' } }, rc.cell.as(rc.root))).id;
    await gateway.call(applyMarking, { body: { markingId: hr, resource: { type: 'property', id: rc.prop('supplier', 'email') } } }, rc.cell.as(rc.root));
    await assert.rejects(gateway.call(changeIndexProperties, {
      params: { siloId: index.id, definitionId }, body: { properties: ['name', 'email'] },
    }, rc.cell.as(rc.root)), { code: 'index.not_cleared' });

    const before = (await latestRefresh()).id;
    await gateway.call(changeIndexProperties, { params: { siloId: index.id, definitionId }, body: { properties: ['name'] } }, rc.cell.as(rc.root));
    await latestRefresh(before);
    assert.ok(!entries().columns.some((c) => c.name.startsWith('region')), 'a removed property drops its column and values');
    const { rows } = await sql(`select payload -> 'detail' as detail from platform.outbox where organisation_id = $1 and payload ->> 'event' = 'index_properties_changed'`,
      [rc.cell.org]);
    assert.deepEqual([rows[0].detail.previous, rows[0].detail.current], ['name,region', 'name']);
  });

  test('a due schedule refreshes on its own', async () => {
    const before = (await latestRefresh()).id;
    await sql(`update siloes.index_definitions set next_refresh_at = now() - interval '1 second' where id = $1`, [definitionId]);
    const scheduled = await latestRefresh(before);
    assert.equal(scheduled.trigger, 'schedule');
    const { rows } = await sql('select next_refresh_at from siloes.index_definitions where id = $1', [definitionId]);
    assert.ok(Date.parse(rows[0].next_refresh_at) > Date.now(), 'claimed once: the next time moved on');
  });

  test('removing a nomination drops its entries; search goes back to the sources', async () => {
    await gateway.call(removeIndexType, { params: { siloId: index.id, definitionId } }, rc.cell.as(rc.root));
    assert.equal(bq.table(indexTableOf(definitionId)), undefined);
    const found = await search('golf');
    assert.equal(found.method, 'federated');
    assert.equal(found.groups[0]!.route, 'federated');
    const events = await auditEvents('index_');
    for (const e of ['index_type_added', 'index_refreshed', 'index_rebuilt', 'index_properties_changed', 'index_type_removed']) assert.ok(events.has(e), e);
    assert.ok((await auditEvents('silo_created')).has('silo_created'));
  });

  test('a purge while a refresh runs ends it: nothing is written after the purge, and what it wrote goes with it (70.2)', async () => {
    const run = bq.run.bind(bq);
    let purged = false;
    // The purge lands just as the refresh reads what the index holds, before its first write.
    bq.run = async (ref, statement, options) => {
      if (!purged && /`_row_hash` from/.test(statement.text)) {
        purged = true;
        await rc.cell.migrate.query('update siloes.index_definitions set removed_at = now(), next_refresh_at = null where silo_id = $1 and removed_at is null', [index.id]);
      }
      return run(ref, statement, options);
    };
    try {
      const added = await gateway.call(addIndexType, {
        params: { siloId: index.id }, body: { objectTypeId: rc.type('supplier').id, properties: ['name'], refreshSchedule: '0 * * * *' },
      }, rc.cell.as(rc.root));
      const refresh = await until('the refresh to stop', async () => {
        const { rows } = await sql(`select status, error_stage from siloes.index_refreshes where index_definition_id = $1 and status <> 'running'`, [added.id]);
        return rows[0] as { status: string; error_stage: string } | undefined;
      });
      assert.deepEqual([refresh.status, refresh.error_stage], ['failed', 'index.purged']);
      assert.equal(bq.table(indexTableOf(added.id)), undefined, 'no entry outlives the purge');
    } finally {
      bq.run = run;
    }
  });
});

// ----------------------------------------------------------------------------- metering

describe('BigQuery metering (spec 69.7, 74.1)', () => {
  test('costs are exact decimals in pounds', () => {
    assert.equal(micros('4.80'), 4_800_000n);
    assert.equal(pounds(5_000_000n), '5.000000');
    assert.equal(computeCost(1n << 40n, micros('5.00')), 5_000_000n);
    // 1 GiB held for a 30-day month at £0.02.
    assert.equal(storageCost(1n << 30n, 30n * 86_400n, micros('0.02')), 20_000n);
    const windows = windowsAfter(Date.UTC(2026, 10, 1, 10), Date.UTC(2026, 10, 3, 1), DAY);
    assert.deepEqual(windows.map((w) => new Date(w.end).toISOString()), ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']);
    assert.equal(windowsAfter(Date.UTC(2026, 10, 3), Date.UTC(2026, 10, 3, 1), DAY).length, 0, 'a measured window is never measured again');
  });

  test('each Silo\'s windows are measured with its own jobs, and recorded for billing', async () => {
    const { rows } = await sql(`select id, store_ref from siloes.siloes where kind = 'object_index'`);
    const silo = rows[0] as { id: string; store_ref: string };
    bq.storageBytes.set(silo.store_ref, 2 ** 30);
    const now = new Date().toISOString();
    bq.jobs.push(
      { jobId: 'j1', projectId: 'silo-test-proj', kind: 'query', labels: { silo_silo: labelValue(silo.id) }, bytesProcessed: 0, bytesBilled: 2 ** 40,
        slotMs: 0, state: 'done', failed: false, createdAt: now, endedAt: now },
      { jobId: 'j2', projectId: 'silo-test-proj', kind: 'query', labels: { silo_silo: 'another_silo' }, bytesProcessed: 0, bytesBilled: 2 ** 40,
        slotMs: 0, state: 'done', failed: false, createdAt: now, endedAt: now },
    );
    const measured = await rc.cell.client('admin-portal').call(measureBigQuery, {}, rc.cell.as(rc.root));
    const mine = measured.measurements.filter((m) => m.siloId === silo.id);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((m) => m.store === 'index' && m.bytesHeld === String(2 ** 30)));
    assert.equal(mine.reduce((sum, m) => sum + micros(m.costCompute), 0n), 5_000_000n, 'its own job only, at £5 per TiB');
    for (const m of mine) assert.equal(micros(m.providerCost), micros(m.costStorage) + micros(m.costCompute));
    const recorded = await sql(`select payload from platform.outbox where organisation_id = $1 and event = 'storage_measured'`, [rc.cell.org]);
    assert.ok(recorded.rows.filter((r) => r.payload.siloId === silo.id).length >= 2);
  });
});

// ----------------------------------------------------------------------------- Warehouse access and exit

describe('Warehouse direct access and exit (spec 69.16, 69.17)', () => {
  let warehouse: WarehouseView;
  const analyst = 'analyst@customer.test';

  before(async () => {
    await gateway.call(createWarehouse, {
      body: { purpose: 'History', retentionDays: 365, objectTypes: [{ objectTypeId: rc.type('supplier').id, properties: ['name', 'region'] }] },
    }, rc.keyed(rc.root));
    warehouse = await until('the Warehouse to be active', async () => {
      const w = await gateway.call(getWarehouse, {}, rc.cell.as(rc.root));
      return w.status === 'active' ? w : undefined;
    }, 60_000);
  });

  test('a super admin grants a named identity read-only access, and revokes it', async () => {
    await assert.rejects(gateway.call(grantWarehouseSqlAccess, { params: { warehouseId: warehouse.id }, body: { googleIdentity: analyst } },
      rc.cell.as(rc.viewer)), { code: 'warehouse.not_permitted' });
    const granted = await gateway.call(grantWarehouseSqlAccess, { params: { warehouseId: warehouse.id }, body: { googleIdentity: 'Analyst@Customer.test' } },
      rc.cell.as(rc.root));
    assert.equal(granted.googleIdentity, analyst);
    assert.ok(bq.access.some((a) => a.member === `user:${analyst}` && a.role === 'reader' && a.dataset === warehouse.dataset));
    assert.ok(bq.jobUsers.some((j) => j.member === `user:${analyst}` && j.projectId === warehouse.projectId));
    assert.ok((await auditEvents('warehouse_sql_access_granted')).size > 0);

    const revoked = await gateway.call(revokeWarehouseSqlAccess, { params: { warehouseId: warehouse.id, grantId: granted.id } }, rc.cell.as(rc.root));
    assert.equal(revoked.revokedReason, 'revoked');
    assert.equal(revoked.revokedBy, rc.root.membershipId);
    assert.ok(!bq.access.some((a) => a.member === `user:${analyst}`));
  });

  test('marked data ends live grants and refuses new ones', async () => {
    const granted = await gateway.call(grantWarehouseSqlAccess, { params: { warehouseId: warehouse.id }, body: { googleIdentity: analyst } },
      rc.cell.as(rc.root));
    const marking = (await gateway.call(createMarking, { body: { name: 'Regional', kind: 'compartment' } }, rc.cell.as(rc.root))).id;
    await gateway.call(grantClearance, { body: { markingId: marking, holder: { kind: 'membership', id: rc.root.membershipId } } }, rc.cell.as(rc.root));
    await gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'property', id: rc.prop('supplier', 'region') } } }, rc.cell.as(rc.root));
    const ended = await until('the system to end the grant', async () => {
      const { grants } = await gateway.call(listWarehouseSqlGrants, { params: { warehouseId: warehouse.id } }, rc.cell.as(rc.root));
      const g = grants.find((x) => x.id === granted.id)!;
      return g.revokedAt !== null ? g : undefined;
    });
    assert.equal(ended.revokedReason, 'marked_data');
    assert.equal(ended.revokedBy, null);
    assert.ok(!bq.access.some((a) => a.member === `user:${analyst}`));
    await assert.rejects(gateway.call(grantWarehouseSqlAccess, { params: { warehouseId: warehouse.id }, body: { googleIdentity: analyst } },
      rc.cell.as(rc.root)), { code: 'warehouse.marked_data' });
  });

  test('every table exports as Parquet with its schema and lineage', async () => {
    const out = await gateway.call(exportWarehouse, { params: { warehouseId: warehouse.id } }, rc.cell.as(rc.root));
    assert.deepEqual(out.tables.map((t) => t.table).sort(), ['supplier', 'supplier__history']);
    for (const t of out.tables) {
      assert.equal(t.uri, `gs://silo-test-files/org/${rc.cell.org}/exports/${out.exportId}/warehouse/${t.table}/part-*.parquet`);
    }
    const lineage = JSON.parse(objects.get(out.lineageKey as ObjectKey)!.toString('utf8'));
    assert.equal(lineage.warehouseId, warehouse.id);
    assert.ok(JSON.parse(objects.get(out.schemaKey as ObjectKey)!.toString('utf8')).supplier.columns.length > 0);
    assert.ok(!objects.get(out.lineageKey as ObjectKey)!.toString('utf8').includes(SUPPLIERS[0]!.name), 'names and counts only, never a value');
  });

  test('hand-over moves the project to the customer and Silo lets go', async () => {
    const moved = await gateway.call(handOverWarehouse, { params: { warehouseId: warehouse.id }, body: { destination: 'organizations/123456789' } },
      rc.cell.as(rc.root));
    assert.equal(moved.status, 'handed_over');
    assert.equal(bq.moved.get(warehouse.projectId), 'organizations/123456789');
    assert.ok(!bq.access.some((a) => WRITERS.includes(a.member)), 'Silo\'s writers leave');
    const after = await gateway.call(getWarehouse, {}, rc.cell.as(rc.root));
    assert.equal(after.status, 'handed_over');
    assert.equal(after.siloStatus, 'disabled');
    await assert.rejects(gateway.call(syncWarehouse, { params: { warehouseId: warehouse.id }, body: { mode: 'scheduled' } }, rc.cell.as(rc.root)),
      { code: 'warehouse.closed' });
    assert.ok((await auditEvents('warehouse_handed_over')).size > 0);
  });
});
