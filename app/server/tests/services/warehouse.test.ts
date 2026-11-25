// The Warehouse core (spec 69.12 to 69.23): provisioning step by step with a clean,
// retryable failure; tables following the ontology; backfill through the federated engine as
// the Warehouse's principal; history from changes; reconciliation and staleness. BigQuery is
// a fake behind the adapter interface (tests/services/warehouse.helper.ts); everything else
// runs as real processes.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  applyWarehouseSchema, createWarehouse, getWarehouse, reconcileWarehouse, retryWarehouseProvisioning, syncWarehouse, type WarehouseView, adoptWarehouse, releaseWarehouse } from '../../src/contracts/warehouse/warehouse.contract.ts';
import { runPlan } from '../../src/contracts/executor/result.contract.ts';
import { warehouseCoverage } from '../../src/contracts/warehouse/read.contract.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { createWarehouseProvisionerService } from '../../src/routes/warehouse-provisioner/index.route.ts';
import { createWarehouseReconcileService } from '../../src/routes/warehouse-reconcile/index.route.ts';
import { createWarehouseSchemaService } from '../../src/routes/warehouse-schema/index.route.ts';
import { createWarehouseSyncService } from '../../src/routes/warehouse-sync/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { applyWarehouseObservations } from '../../src/contracts/warehouse/observations.contract.ts';
import { sweepWarehouse } from '../../src/contracts/warehouse/retention.contract.ts';
import { startRecognitionCell, SUPPLIERS, type RecognitionCell } from './recognition.helper.ts';
import { createFakeBigQuery, type FakeBigQuery } from './warehouse.helper.ts';

let rc: RecognitionCell;
let bq: FakeBigQuery;
let warehouse: WarehouseView;
/** Made after the warehouse services start, so it knows their addresses. */
let gateway: RecognitionCell['gateway'];
const WRITERS = ['serviceAccount:siloes-capture@silo-test-proj.iam.gserviceaccount.com', 'serviceAccount:warehouse-sync@silo-test-proj.iam.gserviceaccount.com'];

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const current = () => gateway.call(getWarehouse, {}, rc.cell.as(rc.root));
let last: unknown;
const settled = (status: WarehouseView['status']) => until(`the Warehouse to be ${status}`, async () => {
  const w = await current();
  last = { status: w.status, step: w.provisioningStep, failed: w.failedStep, tables: w.tables.map((t) => [t.tableName, t.freshness]) };
  return w.status === status ? w : undefined;
}).catch(async (error: unknown) => {
  const { rows } = await inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query('select mode, status, error from siloes.warehouse_sync_runs', []));
  throw new Error(`${String(error)}: ${JSON.stringify(last)} runs ${JSON.stringify(rows)}`);
});

before(async () => {
  rc = await startRecognitionCell([]);
  // Siloes are off until a super admin switches them on (spec 66.6).
  await inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [rc.cell.org]));
  bq = createFakeBigQuery();
  const env = {
    BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', WAREHOUSE_WRITER_MEMBERS: WRITERS.join(','), WAREHOUSE_BATCH_ROWS: '2',
  };
  await rc.cell.start(createWarehouseSchemaService({ bigQuery: bq }), 'warehouse-schema', 'test_app', env);
  await rc.cell.start(createWarehouseSyncService({ bigQuery: bq, schedule: false }), 'warehouse-sync', 'test_app', env);
  await rc.cell.start(createWarehouseReconcileService({ bigQuery: bq, schedule: false }), 'warehouse-reconcile', 'test_app', env);
  await rc.cell.start(createWarehouseProvisionerService({ bigQuery: bq }), 'warehouse-provisioner', 'test_app', env);
  // After warehouse-schema, so it can ask the Warehouse (69.6). Its step bound is below the
  // suppliers' count, so the planner judges an aggregate over them a large set.
  await rc.cell.start(executorService, 'executor', 'test_app', { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: '8' });
  gateway = rc.cell.client('gateway');
});

after(async () => {
  await rc?.close();
});

describe('provisioning (spec 69.13)', () => {
  test('only silo.create holders create a Warehouse', async () => {
    await assert.rejects(gateway.call(createWarehouse, {
      body: { purpose: 'History', retentionDays: 365, objectTypes: [{ objectTypeId: rc.type('order').id, properties: ['order_id'] }] },
    }, rc.keyed(rc.viewer)), { code: 'warehouse.not_permitted' });
  });

  test('a failed step is named, and a retry resumes from it to an active Warehouse', async () => {
    bq.failNext('ensureKey');
    const created = await gateway.call(createWarehouse, {
      body: {
        purpose: 'Supplier history', retentionDays: 365,
        objectTypes: [
          { objectTypeId: rc.type('supplier').id, properties: ['name', 'rating', 'region'] },
          { objectTypeId: rc.type('order').id, properties: ['order_id', 'supplier_id'] },
        ],
      },
    }, rc.keyed(rc.root));
    assert.equal(created.status, 'provisioning');
    assert.equal(created.siloStatus, 'provisioning');
    assert.equal(created.location, 'europe-west2');
    const failed = await settled('failed');
    assert.equal(failed.failedStep, 'key_bound');
    assert.equal(failed.provisioningStep, 'dataset_created');
    const projectCalls = bq.calls.filter((c) => c.method === 'ensureProject').length;

    await gateway.call(retryWarehouseProvisioning, { params: { warehouseId: created.id } }, rc.cell.as(rc.root));
    warehouse = await settled('active');
    assert.equal(warehouse.provisioningStep, 'backfill_started');
    assert.equal(warehouse.failedStep, null);
    assert.equal(bq.calls.filter((c) => c.method === 'ensureProject').length, projectCalls, 'a retry resumes; it does not redo finished steps');
    assert.match(warehouse.projectId, /^silo-uklon1-[0-9a-f]{12}$/);
    assert.equal(bq.datasets.get(`${warehouse.projectId}.${warehouse.dataset}`)?.kmsKeyRef?.endsWith(`/keyRings/silo-warehouse/cryptoKeys/wh-${rc.cell.org.replaceAll('-', '').slice(-20)}`), true);
    assert.deepEqual(bq.access.map((a) => a.member).sort(), [...WRITERS].sort(), 'the writer service accounts only, no person');

    // The organisation moves cells (6.4; D212): its Warehouse stays its own; the cell it left releases it, the cell it moved to adopts it.
    const siloesCapture = rc.cell.client('siloes-capture');
    const asOrganisation = { request: { organisationId: rc.cell.org } };
    assert.deepEqual(await siloesCapture.call(releaseWarehouse, { params: { warehouseId: warehouse.id } }, asOrganisation), { revoked: WRITERS.length });
    assert.deepEqual(bq.access.filter((a) => a.dataset === warehouse.dataset), [], 'the cell it left keeps no access');
    assert.deepEqual(await siloesCapture.call(adoptWarehouse, { params: { warehouseId: warehouse.id } }, asOrganisation), { granted: WRITERS.length });
    assert.deepEqual(bq.access.filter((a) => a.dataset === warehouse.dataset).map((a) => [a.member, a.role]).sort(), [...WRITERS].map((w) => [w, 'writer']).sort());
    assert.ok(WRITERS.every((w) => bq.jobUsers.some((j) => j.projectId === warehouse.projectId && j.member === w)));
    // Adopting starts a catch-up sync and answers at once: it runs to the end before the tests that sync and read back.
    await until('the adopted Warehouse to catch up', async () => {
      const { rows } = await inTx(rc.cell.app, { orgId: rc.cell.org }, () =>
        rc.cell.app.query<{ scheduled: number; running: number }>(
          `select count(*) filter (where mode = 'scheduled')::int as scheduled, count(*) filter (where status = 'running')::int as running from siloes.warehouse_sync_runs`, []));
      return rows[0]!.scheduled > 0 && rows[0]!.running === 0 ? true : undefined;
    });
  });

  test('tables follow the ontology: current, history, and links whose both ends are held', async () => {
    const names = warehouse.tables.map((t) => `${t.kind}:${t.tableName}`).sort();
    assert.deepEqual(names, ['current:order', 'current:supplier', 'history:order__history', 'history:supplier__history', 'link:link__supplier_orders']);
    const supplier = bq.table('supplier')!;
    assert.deepEqual(supplier.columns.map((c) => c.name), [
      'silo_object_id', 'name', 'name__disputed', 'name__sources', 'rating', 'rating__disputed', 'rating__sources', 'region', 'region__disputed',
      'region__sources', '_connection_ids', '_connector_versions', '_ontology_version', '_observed_at', '_hashes', '_first_observed_at',
    ]);
    assert.equal(supplier.columns.find((c) => c.name === 'rating')!.type, 'INTEGER');
  });
});

describe('sync (spec 69.15)', () => {
  test('the backfill holds every object, nominated properties only, with lineage; a disputed value is null with its flag', async () => {
    const orders = bq.table('order')!;
    assert.ok(orders.rows.size > 0);
    for (const row of orders.rows.values()) {
      assert.deepEqual(Object.keys(row).filter((k) => !k.startsWith('_') && !k.includes('__')).sort(), ['order_id', 'silo_object_id', 'supplier_id']);
      assert.deepEqual(row['_connection_ids'], [rc.crm]);
    }
    const suppliers = [...bq.table('supplier')!.rows.values()];
    assert.ok(suppliers.some((r) => (r['_connection_ids'] as string[]).length === 2), 'merged objects name both systems');
    for (const r of suppliers.filter((x) => x['name__disputed'] === true)) {
      assert.equal(r['name'], null);
      assert.equal(r['name__sources'], 2);
    }
    const tables = (await current()).tables.filter((t) => t.kind === 'current');
    assert.ok(tables.every((t) => t.freshness === 'current' && t.lastSyncedAt !== null && t.rowCount > 0));
  });

  test('a changed value writes one history row for that property, and nothing for unchanged ones', async () => {
    const before = bq.table('supplier__history')!.appended.length;
    const changed = SUPPLIERS.find((s) => s.rating !== null)!;
    const was = changed.rating;
    changed.rating = (was ?? 0) + 7;
    try {
      const last = (await current()).tables.find((t) => t.tableName === 'supplier')!.lastSyncedAt;
      await gateway.call(syncWarehouse, { params: { warehouseId: warehouse.id }, body: { mode: 'scheduled', objectTypeIds: [rc.type('supplier').id] } },
        rc.cell.as(rc.root));
      await until('the sync', async () => {
        const t = (await current()).tables.find((x) => x.tableName === 'supplier')!;
        return t.lastSyncedAt !== last ? t : undefined;
      });
      const added = bq.table('supplier__history')!.appended.slice(before);
      assert.equal(added.length, 1);
      assert.equal(added[0]!['property'], 'rating');
      assert.equal(added[0]!['previous_value'], JSON.stringify(was));
      assert.equal(added[0]!['new_value'], JSON.stringify(was! + 7));
    } finally {
      changed.rating = was;
    }
  });
});

describe('the Warehouse as a planner source (spec 69.6)', () => {
  type Answer = { outcome: 'answer'; result: { page: { objects: { id: string; values: Record<string, unknown>; states: Record<string, string> }[] };
    lineage: { servedBy?: { kind: string; asOf: string } }[] } } | { outcome: 'refusal'; refusal: { code: string } };
  const asOf = (at: string, filter?: [string, unknown]) => rc.cell.client('workspace').call(runPlan, {
    body: {
      plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id,
        nodes: [{ objectTypeId: rc.type('supplier').id, filters: filter === undefined ? [] : [{ property: rc.prop('supplier', filter[0]), op: 'eq', value: { param: 'p2' } }] }],
        hops: [], select: [{ node: 0, property: rc.prop('supplier', 'rating') }], sort: [], asOf: { at: { param: 'p1' }, asWritten: 'as of then' } },
      parameters: { p1: at, ...(filter === undefined ? {} : { p2: filter[1] as number }) }, trigger: 'structured', useCache: false,
    },
  }, rc.cell.as(rc.root)) as Promise<Answer>;

  test('each property as it stood then, from the history; refused before the history and for the future', async () => {
    const mine = SUPPLIERS.findLast((x) => x.rating !== null)!;
    const was = mine.rating!;
    const ids = (value: number) => new Set([...bq.table('supplier')!.rows.entries()].filter(([, r]) => r['rating'] === value).map(([id]) => id));
    const already = ids(was + 11);
    const before = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    mine.rating = was + 11;
    try {
      const last = (await current()).tables.find((t) => t.tableName === 'supplier')!.lastSyncedAt;
      await gateway.call(syncWarehouse, { params: { warehouseId: warehouse.id }, body: { mode: 'scheduled', objectTypeIds: [rc.type('supplier').id] } },
        rc.cell.as(rc.root));
      await until('the sync', async () => {
        const t = (await current()).tables.find((x) => x.tableName === 'supplier')!;
        return t.lastSyncedAt !== last ? t : undefined;
      });
    } finally {
      mine.rating = was;
    }
    const id = [...ids(was + 11)].find((x) => !already.has(x))!;
    assert.ok(id, 'the change reached the Warehouse');
    const coverage = await rc.cell.client('executor').call(warehouseCoverage, { body: { objectTypeIds: [rc.type('supplier').id] } }, rc.cell.as(rc.root));
    const { watermark } = coverage.types[0]!;
    assert.ok(coverage.types[0]!.held.includes(rc.prop('supplier', 'rating')));

    const then = await asOf(before);
    assert.equal(then.outcome, 'answer', JSON.stringify(then));
    if (then.outcome !== 'answer') return;
    assert.equal(then.result.page.objects.find((o) => o.id === id)!.values['rating'], was, 'before the change: the previous value');
    assert.ok(then.result.lineage.every((l) => l.servedBy?.kind === 'warehouse' && l.servedBy.asOf === new Date(before).toISOString()), 'answered by the Warehouse, as of then');
    const now = await asOf(watermark);
    assert.equal(now.outcome === 'answer' && now.result.page.objects.find((o) => o.id === id)!.values['rating'], was + 11, 'at the watermark: the current value');
    const matched = async (at: string) => {
      const out = await asOf(at, ['rating', was + 11]);
      return out.outcome === 'answer' && out.result.page.objects.some((o) => o.id === id);
    };
    assert.deepEqual([await matched(before), await matched(watermark)], [false, true], 'filters apply to the values as they stood');

    const early = await asOf('2000-01-01T00:00:00Z');
    assert.deepEqual(early.outcome === 'refusal' && early.refusal.code, 'plan.as_of_unavailable', 'before the history began');
    const future = await asOf(new Date(Date.now() + 86_400_000).toISOString());
    assert.deepEqual(future.outcome === 'refusal' && future.refusal.code, 'plan.as_of_future');
    const order = await rc.cell.client('workspace').call(runPlan, {
      body: { plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id, nodes: [{ objectTypeId: rc.type('order').id, filters: [] }], hops: [],
        select: [{ node: 0, property: rc.prop('order', 'units') }], sort: [], asOf: { at: { param: 'p1' }, asWritten: 'then' } },
      parameters: { p1: before }, trigger: 'structured', useCache: false },
    }, rc.cell.as(rc.root)) as Answer;
    assert.deepEqual(order.outcome === 'refusal' && order.refusal.code, 'plan.as_of_unavailable', 'units is not held in the Warehouse');
  });

  test('a history question: the objects as they stood at the period\'s end, each with its changes in the period, from the history (69.16)', async () => {
    type History = { outcome: 'answer'; result: { history?: { asWritten: string; from: string; to: string; source: string };
      page: { objects: { id: string; values: Record<string, unknown>; changes?: { property: string; at: string; previous: unknown; value: unknown }[] }[] };
      lineage: { servedBy?: { kind: string } }[] } } | { outcome: 'refusal'; refusal: { code: string } };
    const history = (expression: Record<string, unknown>, parameters: Record<string, string> = {}, type = 'supplier', property = 'rating') =>
      rc.cell.client('workspace').call(runPlan, {
        body: {
          plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id, nodes: [{ objectTypeId: rc.type(type).id, filters: [] }], hops: [],
            select: [{ node: 0, property: rc.prop(type, property) }], sort: [], history: { expression: expression as never, asWritten: 'over the past day' } },
          parameters, trigger: 'structured', useCache: false,
        },
      }, rc.cell.as(rc.root)) as Promise<History>;

    // Since the Warehouse's history began (this test made it minutes ago) until its last sync.
    const coverage = await rc.cell.client('executor').call(warehouseCoverage, { body: { objectTypeIds: [rc.type('supplier').id] } }, rc.cell.as(rc.root));
    const span = { p1: coverage.types[0]!.historyFrom, p2: new Date(Date.parse(coverage.types[0]!.watermark) + 1).toISOString() };
    const out = await history({ kind: 'between', from: { param: 'p1' }, to: { param: 'p2' } }, span);
    assert.equal(out.outcome, 'answer', JSON.stringify(out));
    if (out.outcome !== 'answer') return;
    assert.deepEqual([out.result.history?.asWritten, out.result.history?.source], ['over the past day', 'warehouse']);
    assert.ok(out.result.lineage.every((l) => l.servedBy?.kind === 'warehouse'), 'answered by the Warehouse');
    // The change the as-of test made and synced: eleven more than before, in the period, oldest first.
    const changed = out.result.page.objects.find((o) => (o.changes ?? []).some((c) => c.property === 'rating' && Number(c.value) === Number(c.previous) + 11));
    assert.ok(changed, 'the synced change is listed on its object');
    const at = changed.changes!.map((c) => Date.parse(c.at));
    assert.deepEqual(at, [...at].sort((a, b) => a - b), 'oldest first');
    assert.ok(changed.changes!.every((c) => Date.parse(c.at) >= Date.parse(out.result.history!.from) && Date.parse(c.at) < Date.parse(out.result.history!.to)));

    const future = await history({ kind: 'calendar', unit: 'day', offset: 1 });
    assert.deepEqual(future.outcome === 'refusal' && future.refusal.code, 'plan.history_future');
    const early = await history({ kind: 'trailing', unit: 'day', count: 1 });
    assert.deepEqual(early.outcome === 'refusal' && early.refusal.code, 'query.history_unavailable', 'the history does not reach back that far');
    const order = await history({ kind: 'between', from: { param: 'p1' }, to: { param: 'p2' } }, span, 'order', 'units');
    assert.deepEqual(order.outcome === 'refusal' && order.refusal.code, 'plan.as_of_unavailable', 'units is not held in the Warehouse');
  });

  test('a large aggregate is computed in the Warehouse as of its watermark, disputes as the engine counts them; stale, it gives way to the sources', async () => {
    type Grouped = { outcome: 'answer'; result: { aggregateForm: string | null; coverage: { excludedByDispute: number };
      page: { groups: { key: Record<string, unknown>; objects: number; measures: Record<string, number | null>; excluded: Record<string, number> }[] };
      lineage: { servedBy?: { kind: string; asOf: string } }[] } } | { outcome: 'refusal'; refusal: { code: string } };
    type Measure = { fn: 'count' | 'avg' | 'max'; node: number; property?: string; as: string };
    type Filter = { property: string; op: 'gte'; value: { param: string } };
    const grouped = (type: string, by: string, measures: Measure[], filters: Filter[] = [], parameters: Record<string, number> = {}) =>
      rc.cell.client('workspace').call(runPlan, {
        body: { plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id, nodes: [{ objectTypeId: rc.type(type).id, filters }], hops: [], select: [],
          aggregate: { groupBy: [{ node: 0, property: rc.prop(type, by) }], measures }, sort: [] }, parameters, trigger: 'structured', useCache: false },
      }, rc.cell.as(rc.root)) as Promise<Grouped>;
    const rating = rc.prop('supplier', 'rating');
    const measures: Measure[] = [{ fn: 'count', node: 0, as: 'n' }, { fn: 'avg', node: 0, property: rating, as: 'mean' }, { fn: 'max', node: 0, property: rating, as: 'top' }];
    const rows = [...bq.table('supplier')!.rows.values()];
    const coverage = await rc.cell.client('executor').call(warehouseCoverage, { body: { objectTypeIds: [rc.type('supplier').id] } }, rc.cell.as(rc.root));
    assert.equal(coverage.types[0]!.rowCount, rows.length);

    const byRegion = await grouped('supplier', 'region', measures);
    assert.equal(byRegion.outcome, 'answer', JSON.stringify(byRegion));
    if (byRegion.outcome !== 'answer') return;
    const answered = byRegion.result;
    assert.equal(answered.aggregateForm, 'warehouse');
    assert.ok(answered.lineage.every((l) => l.servedBy?.kind === 'warehouse' && l.servedBy.asOf === coverage.types[0]!.watermark), 'as of the watermark');
    const regions = [...new Set(rows.map((r) => r['region'] as string))];
    for (const region of regions) {
      const mine = rows.filter((r) => r['region'] === region);
      const rated = mine.map((r) => r['rating']).filter((v): v is number => typeof v === 'number');
      const group = answered.page.groups.find((g) => g.key['region'] === region)!;
      assert.deepEqual({ objects: group.objects, mean: group.measures['mean'], top: group.measures['top'], left: group.excluded['mean'] }, {
        objects: mine.length, mean: rated.reduce((a, b) => a + b, 0) / rated.length, top: Math.max(...rated), left: mine.length - rated.length,
      }, region);
    }

    // The first five suppliers' names are disputed: left out of the groups and counted.
    const byName = await grouped('supplier', 'name', [{ fn: 'count', node: 0, as: 'n' }]);
    assert.ok(byName.outcome === 'answer');
    assert.equal(byName.result.coverage.excludedByDispute, rows.filter((r) => r['name__disputed'] === true).length);
    assert.equal(byName.result.page.groups.reduce((t, g) => t + g.objects, 0), rows.filter((r) => r['name__disputed'] !== true).length);

    // A filter, applied in the Warehouse.
    const rated = await grouped('supplier', 'region', [{ fn: 'count', node: 0, as: 'n' }], [{ property: rating, op: 'gte', value: { param: 'p1' } }], { p1: 12 });
    assert.ok(rated.outcome === 'answer');
    assert.equal(rated.result.page.groups.reduce((t, g) => t + g.objects, 0), rows.filter((r) => typeof r['rating'] === 'number' && (r['rating'] as number) >= 12).length);

    // Across the suppliers' orders (D116): each region's suppliers, and the orders linked to them, each counted once.
    const link = rc.manifest.linkTypes.find((l) => l.apiName === 'supplier_orders')!;
    const across = await rc.cell.client('workspace').call(runPlan, {
      body: { plan: { schemaVersion: '1', ontologyVersionId: rc.manifest.version.id,
        nodes: [{ objectTypeId: rc.type('supplier').id, filters: [] }, { objectTypeId: rc.type('order').id, filters: [] }],
        hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId: link.defaultRouteId ?? link.routes[0]!.id }], select: [],
        aggregate: { groupBy: [{ node: 0, property: rc.prop('supplier', 'region') }], measures: [{ fn: 'count', node: 0, as: 'suppliers' }, { fn: 'count', node: 1, as: 'orders' }] },
        sort: [] }, parameters: {}, trigger: 'structured', useCache: false },
    }, rc.cell.as(rc.root)) as Grouped;
    assert.equal(across.outcome, 'answer', JSON.stringify(across));
    if (across.outcome !== 'answer') return;
    assert.equal(across.result.aggregateForm, 'warehouse');
    assert.ok(across.result.lineage.every((l) => l.servedBy?.kind === 'warehouse'), 'both sides from the Warehouse');
    const linkRows = [...bq.table('link__supplier_orders')!.appended];
    for (const region of regions) {
      const mine = rows.filter((r) => r['region'] === region);
      const ids = new Set(mine.map((r) => String(r['silo_object_id'])));
      const orderIds = new Set(linkRows.filter((l) => ids.has(String(l['from_object_id']))).map((l) => String(l['to_object_id'])));
      const group: { objects: number; measures: Record<string, number | null> } = across.result.page.groups.find((g) => g.key['region'] === region)!;
      assert.deepEqual([group.objects, group.measures['suppliers'], group.measures['orders']], [mine.length, mine.length, orderIds.size], region);
    }

    // A small set stays with the sources.
    const orders = await grouped('order', 'supplier_id', [{ fn: 'count', node: 0, as: 'n' }]);
    assert.ok(orders.outcome === 'answer' && orders.result.aggregateForm !== 'warehouse');

    // Older than the tolerance: the sources answer, and nothing says the Warehouse did.
    const set = (sql: string) => inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(sql, []));
    await set(`update siloes.warehouse_tables set last_synced_at = last_synced_at - interval '2 hours' where table_name = 'supplier' and kind = 'current'`);
    try {
      const stale = await grouped('supplier', 'region', measures);
      assert.ok(stale.outcome === 'answer' && stale.result.aggregateForm === 'merged', JSON.stringify(stale));
      assert.ok(stale.result.lineage.every((l) => l.servedBy === undefined));
    } finally {
      await set(`update siloes.warehouse_tables set last_synced_at = last_synced_at + interval '2 hours' where table_name = 'supplier' and kind = 'current'`);
    }
  });
});

describe('links, change streams and retention (spec 69.14, 69.15, 70.1)', () => {
  test('a link table holds one row per link between two held objects, with lineage', async () => {
    const links = [...bq.table('link__supplier_orders')!.appended];
    const orders = [...bq.table('order')!.rows.values()];
    assert.equal(links.length, orders.length, 'each order is linked to its supplier');
    const suppliers = new Set([...bq.table('supplier')!.rows.keys()]);
    assert.ok(links.every((l) => suppliers.has(String(l['from_object_id'])) && orders.some((o) => o['silo_object_id'] === l['to_object_id'])));
    assert.ok(links.every((l) => (l['_connection_ids'] as string[]).length > 0 && l['_ontology_version'] !== undefined));
  });

  test('a change stream\'s observation updates the current row and adds a history row; the same value again writes nothing', async () => {
    const [id, row] = [...bq.table('supplier')!.rows.entries()].find(([, r]) => r['rating'] !== null)!;
    const before = bq.table('supplier__history')!.appended.length;
    const observe = (value: number) => rc.cell.client('siloes-capture').call(applyWarehouseObservations, { body: { siloId: warehouse.siloId, entries: [{
      objectTypeId: rc.type('supplier').id, objectRef: id, property: 'rating', value, observedAt: new Date().toISOString(), connectionId: rc.crm,
    }] } }, { request: { organisationId: rc.cell.org }, correlationId: uuidv7() });
    const first = await observe(Number(row['rating']) + 100);
    assert.deepEqual([first.applied, first.history, first.skipped], [1, 1, 0]);
    const updated = bq.table('supplier')!.rows.get(id)!;
    assert.equal(updated['rating'], Number(row['rating']) + 100);
    assert.equal(updated['name'], row['name'], 'the other columns stand');
    const added = bq.table('supplier__history')!.appended.slice(before);
    assert.deepEqual(added.map((h) => [h['property'], h['new_value']]), [['rating', JSON.stringify(Number(row['rating']) + 100)]]);
    const again = await observe(Number(row['rating']) + 100);
    assert.deepEqual([again.applied, again.history], [0, 0], 'unchanged by hash: nothing written');
  });

  test('history older than the window goes, and a column whose property left goes once the window has passed', async () => {
    bq.table('supplier')!.columns.push({ name: 'legacy_code', type: 'STRING', mode: 'NULLABLE' });
    const principal = (await inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(
      'select service_principal_id from siloes.warehouse_projects where id = $1', [warehouse.id]))).rows[0].service_principal_id as string;
    await rc.cell.client('warehouse-sync').call(applyWarehouseSchema, { params: { warehouseId: warehouse.id } },
      { request: { organisationId: rc.cell.org, servicePrincipalId: principal }, correlationId: uuidv7() });
    const { rows } = await inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(
      `select retired_columns from siloes.warehouse_tables where table_name = 'supplier'`, []));
    assert.deepEqual(Object.keys(rows[0].retired_columns), ['legacy_code'], 'kept, with when it was retired');
    const call = (before: string) => rc.cell.client('siloes-capture').call(sweepWarehouse, { params: { siloId: warehouse.siloId }, body: { before } },
      { request: { organisationId: rc.cell.org }, correlationId: uuidv7() });
    const early = await call(new Date(Date.now() - 86_400_000).toISOString());
    assert.equal(early.columnsDropped, 0, 'within the window: kept');
    const late = await call(new Date(Date.now() + 86_400_000).toISOString());
    assert.equal(late.columnsDropped, 1);
    assert.ok(late.historyRows >= 1);
    assert.ok(!bq.table('supplier')!.columns.some((c) => c.name === 'legacy_code'));
  });
});

describe('reconciliation (spec 69.15)', () => {
  test('a missing row is drift: reported and resynced', async () => {
    const orders = bq.table('order')!;
    const [id] = [...orders.rows.keys()];
    orders.rows.delete(id!);
    const out = await gateway.call(reconcileWarehouse, { params: { warehouseId: warehouse.id } }, rc.cell.as(rc.root));
    const order = out.tables.find((t) => t.objectTypeId === rc.type('order').id)!;
    assert.equal(order.outcome, 'resynced');
    assert.equal(order.tableCount, order.sourceCount - 1);
    assert.equal(out.tables.find((t) => t.objectTypeId === rc.type('supplier').id)!.outcome, 'in_step');
    await until('the resync', async () => (orders.rows.has(id!) ? true : undefined));
  });

  test('an unreachable source marks its table stale, never current', async () => {
    rc.failing.add('/v1/orders');
    try {
      const out = await gateway.call(reconcileWarehouse, { params: { warehouseId: warehouse.id } }, rc.cell.as(rc.root));
      assert.equal(out.tables.find((t) => t.objectTypeId === rc.type('order').id)!.outcome, 'source_unreachable');
      const tables = (await current()).tables;
      assert.equal(tables.find((t) => t.tableName === 'order')!.freshness, 'stale');
      assert.equal(tables.find((t) => t.tableName === 'supplier')!.freshness, 'current');
    } finally {
      rc.failing.delete('/v1/orders');
    }
  });

  test('every step is audited', async () => {
    const { rows } = await inTx(rc.cell.app, { orgId: rc.cell.org }, () => rc.cell.app.query(
      `select payload ->> 'event' as event from platform.outbox where organisation_id = $1 and payload ->> 'event' like 'warehouse_%'`, [rc.cell.org]));
    const events = new Set(rows.map((r) => r.event as string));
    for (const e of ['warehouse_provision_failed', 'warehouse_provisioned', 'warehouse_table_created', 'warehouse_backfill_completed', 'warehouse_reconciled']) {
      assert.ok(events.has(e), e);
    }
  });
});
