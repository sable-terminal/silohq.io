// Warehouse retention (spec 69.14, 70.1): see contracts/warehouse/retention.contract.ts. As the
// Warehouse's own principal: history observed before the cutoff goes; a retired column whose
// retirement is older than the cutoff is dropped with its values, and forgotten.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { warehouseProjectRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { dropColumns } from './generator/index.generator.ts';
import { deleteHistoryBefore } from './generator/warehouse.generator.ts';
import { datasetOf, type Context, type WarehouseDeps } from './warehouse.service.ts';

export async function sweepWarehouse(deps: WarehouseDeps, ctx: Context, siloId: string, before: string): Promise<{ historyRows: number; columnsDropped: number }> {
  const pool = deps.databases.pool('control');
  const loaded = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findByOrganisationId(db, ctx.request.organisationId!);
    if (project === undefined || project.siloId !== siloId || project.status === 'handed_over' || project.status === 'purged') return undefined;
    return { project, tables: (await warehouseTableRepo.listForProject(db, project.id)).filter((t) => t.droppedAt === null) };
  }, { readOnly: true });
  if (loaded === undefined) return { historyRows: 0, columnsDropped: 0 };
  const ref = datasetOf(loaded.project);
  const options = { labels: { organisation: loaded.project.organisationId, service: 'warehouse-schema', purpose: 'warehouse_schema' as const } };
  let historyRows = 0;
  let columnsDropped = 0;
  for (const t of loaded.tables) {
    if (t.kind === 'history') {
      historyRows += (await deps.bigQuery.run(ref, deleteHistoryBefore(ref, t.tableName, before), options)).affectedRows ?? 0;
      continue;
    }
    const retired = (t.retiredColumns ?? {}) as Record<string, string>;
    const due = Object.entries(retired).filter(([, at]) => at < before).map(([name]) => name);
    if (t.kind !== 'current' || due.length === 0) continue;
    await deps.bigQuery.run(ref, dropColumns(ref, t.tableName, due), options);
    columnsDropped += due.length;
    const left = Object.fromEntries(Object.entries(retired).filter(([name]) => !due.includes(name)));
    await inTransaction(pool, ctx.request, (db) => warehouseTableRepo.update(db, t.id, { retiredColumns: left as never }));
  }
  return { historyRows, columnsDropped };
}
