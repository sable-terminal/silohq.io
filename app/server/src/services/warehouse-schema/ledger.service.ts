// The Action ledger's switch (spec 48.2, 66.4): a holder of silo.enable turns it on, with
// references only or with values, having acknowledged its disclosure, or off. Off by default.
// Turning it on creates the ledger table in the Warehouse's dataset (once); turning it off
// stops new rows and keeps the table, which goes with the Warehouse's own purge. The Silo
// records when it was switched on and whether with values; who chose it is the
// ledger_enabled event (with whether values were chosen), or ledger_disabled, written in the
// change's transaction.

import type { WarehouseTableView } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloRepo, warehouseProjectRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { requireSiloes } from '../siloes-capture/deps.service.ts';
import { createTable, LEDGER_COLUMNS, LEDGER_TABLE } from './generator/warehouse.generator.ts';
import { datasetOf, demand, ledgerMode, readManifest, recordEvent, warehouseView, type Context, type WarehouseDeps } from './warehouse.service.ts';

export const LEDGER_DISCLOSURE = 'Switching the Action ledger on keeps a copy of every executed Action in this Warehouse: one row per object, '
  + 'with the Action type, the people who proposed and approved it, the fields written and the outcome. With values, the copy holds the '
  + 'values before and after each write as well. The receipt in Silo remains the record; the copy carries the markings of what it '
  + 'describes, and is removed when the Warehouse is purged.';

export async function setActionLedger(deps: WarehouseDeps, ctx: Context, warehouseId: string, mode: 'off' | 'references' | 'values', acknowledged: boolean)
  : Promise<{ mode: 'off' | 'references' | 'values'; disclosure: string; table: WarehouseTableView | null }> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.enable');
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) throw new AppError('forbidden', 'a person switches the Action ledger', { code: 'warehouse.ledger_person_only' });
  if (mode !== 'off' && !acknowledged) {
    throw new AppError('validation', 'read and acknowledge the Action ledger disclosure first', { code: 'warehouse.ledger_disclosure', details: { disclosure: LEDGER_DISCLOSURE } });
  }
  const pool = deps.databases.pool('control');
  const project = await inTransaction(pool, ctx.request, (db) => warehouseProjectRepo.findById(db, warehouseId), { readOnly: true });
  if (!project) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
  if (mode !== 'off' && project.status !== 'active' && project.status !== 'backfilling') {
    throw new AppError('conflict', `a ${project.status} Warehouse takes no ledger`, { code: 'warehouse.not_active' });
  }
  // The table first: BigQuery is outside the transaction, and creating it twice changes nothing.
  const ontologyVersionId = mode === 'off' ? undefined : (await readManifest(deps, ctx)).version.id;
  if (mode !== 'off') {
    await deps.bigQuery.run(datasetOf(project), createTable(datasetOf(project), LEDGER_TABLE, LEDGER_COLUMNS), {
      labels: { organisation: project.organisationId, service: 'warehouse-schema', purpose: 'warehouse_schema', silo: project.siloId },
    });
  }

  const view = await inTransaction(pool, ctx.request, async (db) => {
    const current = (await warehouseProjectRepo.findById(db, warehouseId))!;
    const silo = (await siloRepo.findById(db, current.siloId))!;
    if (ledgerMode(silo) !== mode) {
      await siloRepo.update(db, silo.id, {
        actionLedgerEnabledAt: mode === 'off' ? null : new Date().toISOString(), actionLedgerIncludeValues: mode === 'off' ? null : mode === 'values',
        version: String(Number(silo.version) + 1),
      });
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: mode === 'off' ? 'ledger_disabled' : 'ledger_enabled', resource: { type: 'warehouse', id: warehouseId },
        ...(mode === 'off' ? {} : { detail: { values: mode === 'values' } }), service: 'warehouse-schema',
      });
    }
    if (mode !== 'off' && await warehouseTableRepo.findByWarehouseProjectIdAndTableName(db, { organisationId: current.organisationId, warehouseProjectId: warehouseId, tableName: LEDGER_TABLE }) === undefined) {
      await warehouseTableRepo.insert(db, {
        id: uuidv7(), organisationId: current.organisationId, warehouseProjectId: warehouseId, tableName: LEDGER_TABLE, kind: 'ledger',
        ontologyVersionId: ontologyVersionId!,
      });
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'warehouse_table_created', resource: { type: 'warehouse', id: warehouseId }, detail: { table: LEDGER_TABLE, kind: 'ledger' }, service: 'warehouse-schema',
      });
    }
    return warehouseView(db, (await warehouseProjectRepo.findById(db, warehouseId))!);
  });
  return { mode, disclosure: LEDGER_DISCLOSURE, table: view.tables.find((t) => t.kind === 'ledger') ?? null };
}
