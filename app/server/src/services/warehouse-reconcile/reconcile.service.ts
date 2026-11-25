// warehouse-reconcile (spec 69.15): compares each current table with its sources and
// resyncs drift.
//
// For each nominated type: the sources' object count (the federated engine's population,
// read as the Warehouse's principal), the table's row count, and whether a sample of the
// sources' object ids is present in the table. Any difference starts a resync of that
// type (warehouse-sync, mode reconcile). A source that cannot be read marks the table stale,
// with a failed run, so it is never shown as current.

import { runPlan } from '../../contracts/executor/result.contract.ts';
import { PLAN_SCHEMA_VERSION } from '../../contracts/planner/plan.contract.ts';
import { syncWarehouse } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloObjectTypeRepo, warehouseProjectRepo, warehouseSyncRunRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { requireSiloes } from '../siloes-capture/deps.service.ts';
import { countRows, presentKeys, ID_COLUMN } from '../warehouse-schema/generator/warehouse.generator.ts';
import { asWarehouse, datasetOf, demand, readManifest, recordEvent, type Context, type WarehouseDeps } from '../warehouse-schema/warehouse.service.ts';

export interface TableReconciliation {
  tableId: string;
  objectTypeId: string;
  sourceCount: number;
  tableCount: number;
  sampled: number;
  missing: number;
  outcome: 'in_step' | 'resynced' | 'source_unreachable';
}

/** A person asks (silo.manage); the scheduled pass acts as the Warehouse's principal already. */
export async function reconcile(deps: WarehouseDeps, ctx: Context, warehouseId: string, asked: boolean): Promise<{ tables: TableReconciliation[] }> {
  if (asked) {
    await requireSiloes(deps, ctx);
    await demand(deps, ctx, 'silo.manage');
  }
  const pool = deps.databases.pool('control');
  const { project, targets } = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findById(db, warehouseId);
    if (!project) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
    if (project.status !== 'active') throw new AppError('conflict', 'only an active Warehouse is reconciled', { code: 'warehouse.not_active' });
    const tables = await warehouseTableRepo.listForProject(db, project.id);
    const targets = (await siloObjectTypeRepo.listLive(db, project.siloId)).flatMap((n) => {
      const table = tables.find((t) => t.kind === 'current' && t.objectTypeId === n.objectTypeId);
      return table === undefined ? [] : [{ objectTypeId: n.objectTypeId, table }];
    });
    return { project, targets };
  }, { readOnly: true });

  const principal = asWarehouse(project, ctx.correlationId);
  const call = { request: principal.request, correlationId: ctx.correlationId };
  const ref = datasetOf(project);
  const options = { labels: { organisation: project.organisationId, service: 'warehouse-reconcile', purpose: 'warehouse_reconcile' as const } };
  const manifest = await readManifest(deps, principal);
  const out: TableReconciliation[] = [];
  const drifted: string[] = [];
  for (const { objectTypeId, table } of targets) {
    try {
      const outcome = await deps.services.call(runPlan, {
        body: {
          plan: { schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId, filters: [] }], hops: [], select: [], sort: [] },
          parameters: {}, trigger: 'structured', useCache: false,
        },
      }, { ...call, timeoutMs: 120_000 });
      if (outcome.outcome === 'refusal') {
        throw new AppError('bounds', 'the federated engine refused the read', { code: 'warehouse.read_refused', details: { reason: outcome.refusal.code } });
      }
      const sample = outcome.result.page.objects.slice(0, deps.config.reconcileSample).map((o) => o.id);
      const counted = await deps.bigQuery.run(ref, countRows(ref, table.tableName), options);
      const tableCount = Number(counted.rows[0]?.['n'] ?? 0);
      const present = sample.length === 0 ? new Set<string>()
        : new Set((await deps.bigQuery.run(ref, presentKeys(ref, table.tableName, sample), options)).rows.map((r) => String(r[ID_COLUMN.name])));
      const missing = sample.filter((id) => !present.has(id)).length;
      const sourceCount = outcome.result.population;
      const inStep = sourceCount === tableCount && missing === 0;
      if (!inStep) drifted.push(objectTypeId);
      out.push({ tableId: table.id, objectTypeId, sourceCount, tableCount, sampled: sample.length, missing, outcome: inStep ? 'in_step' : 'resynced' });
    } catch (error) {
      // The source could not be read: the table is stale until a sync completes.
      await inTransaction(pool, principal.request, (db) => warehouseSyncRunRepo.insert(db, {
        id: uuidv7(), organisationId: project.organisationId, warehouseTableId: table.id, mode: 'reconcile', status: 'failed',
        error: isAppError(error) ? error.code : 'warehouse.reconcile_failed', completedAt: new Date().toISOString(),
      }));
      out.push({ tableId: table.id, objectTypeId, sourceCount: 0, tableCount: Number(table.rowCount), sampled: 0, missing: 0, outcome: 'source_unreachable' });
    }
  }
  if (drifted.length > 0) {
    await deps.services.call(syncWarehouse, { params: { warehouseId: project.id }, body: { mode: 'reconcile', objectTypeIds: drifted } }, call);
  }
  await inTransaction(pool, principal.request, (db) => recordEvent(db, asked ? ctx.request : principal.request, ctx.correlationId, {
    event: 'warehouse_reconciled', resource: { type: 'warehouse', id: project.id },
    detail: { tables: out.length, resynced: drifted.length, unreachable: out.filter((t) => t.outcome === 'source_unreachable').length },
  }));
  return { tables: out };
}
