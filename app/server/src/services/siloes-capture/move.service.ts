// Siloes when their organisation moves cells (spec 6.4, 66; D212). The organisation's rows and
// Silo files travel in the tenant migration's bundle; what lives in a cell's BigQuery does not.
// tenant-migrations calls these at each end:
//
// - Moved in (the destination, before the directory names it): each Import Silo's rows rebuilt
//   in this cell's dataset from the moved files and stored extractions (no model is called);
//   each Object Index nomination rebuilt (its refresh reads the sources once they are
//   re-authorised); the Warehouse, the organisation's own project, adopted by this cell.
// - Moved out (the source, before it purges): each Import dataset and Object Index dataset of
//   the organisation dropped from this cell, and this cell's access to the Warehouse revoked.
// Capture lives in Postgres and moved with the rows. Each step is safe to run again.

import { purgeObjectIndex, rebuildIndexType } from '../../contracts/index-builder/index.contract.ts';
import { dropImportDataset } from '../../contracts/import-loader/load.contract.ts';
import { rebuildImportSilo } from '../../contracts/siloes/import.contract.ts';
import { adoptWarehouse, releaseWarehouse } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { indexDefinitionRepo, siloRepo, warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import type { Context, SiloesDeps } from './deps.service.ts';

export interface MovedIn { importSilos: number; files: number; rows: number; indexTypes: number; warehouse: boolean }
export interface MovedOut { importDatasets: number; indexDatasets: number; warehouse: boolean }

async function holdings(deps: Pick<SiloesDeps, 'databases'>, ctx: Context) {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const siloes = (await siloRepo.list(db, false)).filter((s) => s.status !== 'purging');
    const definitions = new Map<string, string[]>();
    for (const s of siloes.filter((x) => x.kind === 'object_index')) {
      definitions.set(s.id, (await indexDefinitionRepo.listForSilo(db, s.id, false)).filter((d) => d.removedAt === null).map((d) => d.id));
    }
    const warehouse = await warehouseProjectRepo.findByOrganisationId(db, ctx.request.organisationId!);
    return { siloes, definitions, warehouse };
  }, { readOnly: true });
}

export async function adoptMovedSiloes(deps: SiloesDeps, ctx: Context): Promise<MovedIn> {
  const { siloes, definitions, warehouse } = await holdings(deps, ctx);
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const out: MovedIn = { importSilos: 0, files: 0, rows: 0, indexTypes: 0, warehouse: false };
  for (const silo of siloes) {
    if (silo.kind === 'import') {
      const rebuilt = await deps.services.call(rebuildImportSilo, { params: { siloId: silo.id } }, call);
      out.importSilos += 1;
      out.files += rebuilt.files;
      out.rows += rebuilt.rows;
    } else if (silo.kind === 'object_index') {
      for (const definitionId of definitions.get(silo.id) ?? []) {
        await deps.services.call(rebuildIndexType, { params: { siloId: silo.id, definitionId } }, call).catch((error: unknown) => {
          // A refresh already running rebuilds it as well.
          if ((error as { code?: string }).code !== 'index.refresh_running') throw error;
        });
        out.indexTypes += 1;
      }
    }
  }
  if (warehouse !== undefined && warehouse.status !== 'purged' && warehouse.status !== 'handed_over') {
    await deps.services.call(adoptWarehouse, { params: { warehouseId: warehouse.id } }, call);
    out.warehouse = true;
  }
  deps.logger.info('the organisation\'s Siloes were adopted by this cell', {
    event: 'siloes.moved_in', organisationId: ctx.request.organisationId!, count: out.importSilos + out.indexTypes,
  });
  return out;
}

export async function releaseMovedSiloes(deps: SiloesDeps, ctx: Context): Promise<MovedOut> {
  const { siloes, warehouse } = await holdings(deps, ctx);
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const out: MovedOut = { importDatasets: 0, indexDatasets: 0, warehouse: false };
  for (const silo of siloes) {
    if (silo.kind === 'import') {
      if ((await deps.services.call(dropImportDataset, { body: { siloId: silo.id } }, call)).dropped) out.importDatasets += 1;
    } else if (silo.kind === 'object_index') {
      if ((await deps.services.call(purgeObjectIndex, { params: { siloId: silo.id }, body: {} }, call)).dropped) out.indexDatasets += 1;
    }
  }
  if (warehouse !== undefined && warehouse.status !== 'purged') {
    await deps.services.call(releaseWarehouse, { params: { warehouseId: warehouse.id } }, call);
    out.warehouse = true;
  }
  deps.logger.info('the organisation\'s Silo stores were released by this cell', {
    event: 'siloes.moved_out', organisationId: ctx.request.organisationId!, count: out.importDatasets + out.indexDatasets,
  });
  return out;
}
