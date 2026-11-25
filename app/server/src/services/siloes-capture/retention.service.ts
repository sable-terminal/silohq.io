// Retention (spec 70.1): every Silo keeps data for its stated window, enforced by this sweep
// from its first day; a window in a settings table that nothing enforces is worse than none.
//
//   Capture       transitions observed, and baselines last seen, before the cutoff
//   Import        files received before it: the file in object storage, its rows in
//                 BigQuery and its extracted values
//   Object Index  entries not refreshed within the window
//   Warehouse     history observed before the cutoff, and columns whose property left the
//                 nomination before it (69.14)
// Every deletion is audited as retention_swept with its counts.

import { sweepObjectIndex } from '../../contracts/index-builder/index.contract.ts';
import { sweepWarehouse } from '../../contracts/warehouse/retention.contract.ts';
import { dropExpiredImportRows } from '../../contracts/import-loader/load.contract.ts';
import type { SILO_KINDS } from '../../contracts/siloes/siloes.contract.ts';
import type { ObjectKey } from '../../infra/objectStorage.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloExtractionRepo, siloFileRepo, siloRepo, transitionRepo } from '../../repos/siloes/index.repo.ts';
import { recordEvent } from '../warehouse-schema/warehouse.service.ts';
import type { Context } from './deps.service.ts';
import type { PurgeDeps } from './purge.service.ts';

const DAY = 86_400_000;

export interface Swept {
  siloId: string;
  kind: (typeof SILO_KINDS)[number];
  counts: Record<string, number>;
}

export async function sweepSilo(deps: PurgeDeps, organisationId: string, siloId: string, correlationId: string): Promise<Swept | undefined> {
  const ctx: Context = { request: { organisationId }, correlationId };
  const pool = deps.databases.pool('control');
  const silo = await inTransaction(pool, ctx.request, (db) => siloRepo.findById(db, siloId), { readOnly: true });
  if (silo === undefined || silo.disabledAt !== null || silo.status === 'purging') return undefined;
  const cutoff = new Date(deps.now() - silo.retentionDays * DAY).toISOString();
  const call = { request: ctx.request, correlationId };
  let counts: Record<string, number> = {};
  switch (silo.kind) {
    case 'capture': {
      // The Action ledger copy it holds keeps to the same window (D205); counted where any went.
      const { ledger, ...swept } = await inTransaction(pool, ctx.request, (db) => transitionRepo.sweep(db, organisationId, silo.id, cutoff));
      counts = ledger > 0 ? { ...swept, ledger } : swept;
      break;
    }
    case 'import': {
      const files = await inTransaction(pool, ctx.request, (db) => siloFileRepo.heldBefore(db, silo.id, cutoff), { readOnly: true });
      let extractions = 0;
      let bytes = 0;
      for (const f of files) {
        if (deps.store !== undefined) await deps.store.purge('siloes', f.objectStoreKey as ObjectKey);
        bytes += Number(f.sizeBytes);
        extractions += await inTransaction(pool, ctx.request, async (db) => {
          const removed = await siloExtractionRepo.purge(db, organisationId, silo.id, f.id, null);
          await siloFileRepo.update(db, f.id, { status: 'purged', purgedAt: new Date(deps.now()).toISOString() });
          return removed;
        });
      }
      const rows = await deps.services.call(dropExpiredImportRows, { body: { siloId: silo.id, receivedBefore: cutoff } }, call)
        .catch((error: unknown) => {
          // No dataset yet (nothing loaded): nothing to sweep there.
          deps.logger.failure('Import rows could not be swept this pass', error, { event: 'siloes.retention_rows_failed', organisationId });
          return { tables: 0, rowsDeleted: 0 };
        });
      counts = { files: files.length, bytes, extractions, rows: rows.rowsDeleted };
      break;
    }
    case 'object_index': {
      const out = await deps.services.call(sweepObjectIndex, { params: { siloId: silo.id }, body: { refreshedBefore: cutoff } }, call);
      counts = { entries: out.entriesRemoved };
      break;
    }
    case 'warehouse': {
      const out = await deps.services.call(sweepWarehouse, { params: { siloId: silo.id }, body: { before: cutoff } }, call);
      counts = { history: out.historyRows, columns: out.columnsDropped };
      break;
    }
  }
  if (Object.values(counts).some((n) => n > 0)) {
    await inTransaction(pool, ctx.request, (db) => recordEvent(db, ctx.request, correlationId, {
      event: 'retention_swept', resource: { type: 'silo', id: silo.id }, detail: { cutoff, ...counts }, service: 'siloes-capture',
    }));
  }
  return { siloId: silo.id, kind: silo.kind, counts };
}

export async function sweepOrganisation(deps: PurgeDeps, organisationId: string, correlationId: string): Promise<Swept[]> {
  const siloes = await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => siloRepo.list(db, false), { readOnly: true });
  const out: Swept[] = [];
  for (const s of siloes) {
    const swept = await sweepSilo(deps, organisationId, s.id, correlationId).catch((error: unknown) => {
      deps.logger.failure('a Silo could not be swept; the next pass tries again', error, { event: 'siloes.retention_failed', organisationId });
      return undefined;
    });
    if (swept !== undefined) out.push(swept);
  }
  return out;
}

export async function sweepAll(deps: PurgeDeps, correlationId: string): Promise<number> {
  const siloes = await inTransaction(deps.databases.pool('control'), {}, (db) => siloRepo.liveAcrossCell(db, 100_000), { readOnly: true });
  let swept = 0;
  for (const organisationId of new Set(siloes.map((s) => s.organisationId))) swept += (await sweepOrganisation(deps, organisationId, correlationId)).length;
  return swept;
}
