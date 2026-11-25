// The Action ledger's rows (spec 48.2): the actions service sends one row per object of an
// executed Action after its receipt exists; they are merged into the ledger table by ledger
// id, so a repeat adds nothing. Values are kept only where the ledger holds them: with
// references only, prior and new values are dropped here, whatever was sent. Off, nothing
// is written. Each write is ledger_row_written with the count, never a value.

import type { LedgerRow } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloRepo, warehouseProjectRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { datasetOf, ledgerMode, recordEvent, type Context, type WarehouseDeps } from '../warehouse-schema/warehouse.service.ts';
import { clearLedgerValues, LEDGER_TABLE, mergeLedger } from '../warehouse-schema/generator/warehouse.generator.ts';

const BATCH = 1_000;

export async function writeLedger(deps: WarehouseDeps, ctx: Context, receiptId: string, rows: readonly LedgerRow[])
  : Promise<{ written: number; mode: 'off' | 'references' | 'values' }> {
  const pool = deps.databases.pool('control');
  const organisationId = ctx.request.organisationId!;
  const found = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findByOrganisationId(db, organisationId);
    const table = project === undefined ? undefined
      : await warehouseTableRepo.findByWarehouseProjectIdAndTableName(db, { organisationId, warehouseProjectId: project.id, tableName: LEDGER_TABLE });
    const silo = project === undefined ? undefined : await siloRepo.findById(db, project.siloId);
    return { project, table, mode: silo === undefined ? 'off' as const : ledgerMode(silo) };
  }, { readOnly: true });
  const { project, table, mode } = found;
  if (project === undefined || mode === 'off' || table === undefined || project.status === 'purged' || project.status === 'handed_over') {
    return { written: 0, mode };
  }
  const values = mode === 'values';
  const out = rows.map((r) => ({
    ledger_id: r.ledgerId, organisation_id: organisationId, mutation_id: r.mutationId, receipt_id: r.receiptId, commit_id: r.commitId,
    action_type: r.actionType, generic_edit: r.genericEdit, risk_class: r.riskClass, object_type: r.objectType, object_id: r.objectId,
    connection_id: r.connectionId, operation: r.operation, fields: r.fields,
    prior_values: values && r.priorValues !== null ? JSON.stringify(r.priorValues) : null,
    new_values: values && r.newValues !== null ? JSON.stringify(r.newValues) : null,
    proposer: r.proposer, approvers: r.approvers, self_approved: r.selfApproved, origin: r.origin, outcome: r.outcome,
    reverts_mutation_id: r.revertsMutationId, proposed_at: r.proposedAt, executed_at: r.executedAt, _marking_ids: r.markingIds,
  }));
  const ref = datasetOf(project);
  let written = 0;
  for (let i = 0; i < out.length; i += BATCH) {
    const result = await deps.bigQuery.run(ref, mergeLedger(ref, out.slice(i, i + BATCH)), {
      labels: { organisation: organisationId, service: 'warehouse-sync', purpose: 'warehouse_sync', silo: project.siloId },
    });
    written += result.affectedRows ?? 0;
  }
  await inTransaction(pool, ctx.request, async (db) => {
    await warehouseTableRepo.update(db, table.id, { rowCount: String(Number(table.rowCount) + written), lastSyncedAt: new Date().toISOString() });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'ledger_row_written', resource: { type: 'warehouse', id: project.id }, detail: { rows: written, receipt_id: receiptId }, service: 'warehouse-sync',
    });
  });
  return { written, mode };
}

/**
 * Receipt purge reaches the ledger (48.2): where it holds values, the purged receipts' rows
 * lose them; references and outcomes stay, as in the receipt. With references only, or off,
 * there is nothing to clear.
 */
export async function purgeLedgerValues(deps: WarehouseDeps, ctx: Context, receiptIds: readonly string[])
  : Promise<{ rows: number; mode: 'off' | 'references' | 'values' }> {
  const pool = deps.databases.pool('control');
  const organisationId = ctx.request.organisationId!;
  const { project, table, mode } = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findByOrganisationId(db, organisationId);
    const table = project === undefined ? undefined
      : await warehouseTableRepo.findByWarehouseProjectIdAndTableName(db, { organisationId, warehouseProjectId: project.id, tableName: LEDGER_TABLE });
    const silo = project === undefined ? undefined : await siloRepo.findById(db, project.siloId);
    return { project, table, mode: silo === undefined ? 'off' as const : ledgerMode(silo) };
  }, { readOnly: true });
  if (project === undefined || table === undefined || mode !== 'values' || project.status === 'purged' || project.status === 'handed_over') return { rows: 0, mode };
  const ref = datasetOf(project);
  const labels = { labels: { organisation: organisationId, service: 'warehouse-sync', purpose: 'warehouse_sync' as const, silo: project.siloId } };
  let rows = 0;
  for (const column of ['prior_values', 'new_values'] as const) {
    const result = await deps.bigQuery.run(ref, clearLedgerValues(ref, column, [...receiptIds]), labels);
    rows = Math.max(rows, result.affectedRows ?? 0);
  }
  await inTransaction(pool, ctx.request, (db) => recordEvent(db, ctx.request, ctx.correlationId, {
    event: 'ledger_purged', resource: { type: 'warehouse', id: project.id }, detail: { reason: 'receipt_purge', receipts: receiptIds.length, rows, receipts_kept: true },
    service: 'warehouse-sync',
  }));
  return { rows, mode };
}
