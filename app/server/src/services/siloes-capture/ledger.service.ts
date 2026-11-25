// The Action ledger in a Capture Silo (spec 48.2, 66.4, 70; D205): where the cell has no
// Warehouse (the sovereign build compiles it out), "the ledger requires a configured UK-resident
// store", and the organisation's Capture Silo is that store: the cell's own Postgres.
//
// - The switch, as the Warehouse's (warehouse-schema/ledger.service.ts): silo.enable, a person,
//   the disclosure acknowledged to turn it on, off by default. One Silo holds an organisation's
//   ledger (siloes_one_ledger). Who chose it is the ledger_enabled or ledger_disabled event.
// - Rows by ledger id, inserted once, so actions retrying a copy adds nothing. Values only with
//   the values option, each column sealed under the organisation's data key and bound to its row
//   and column.
// - Receipt purge clears values wherever they are held, whatever the mode is now: a ledger
//   switched from values to references still held them.
// - Reading goes through the reader's own access: a row with a marking the reader does not
//   satisfy, or of an object type they cannot see, is withheld and counted (58).

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import type { CaptureLedgerRow } from '../../contracts/siloes/captureLedger.contract.ts';
import type { LedgerRow } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ActionLedger, Silo } from '../../models/siloes/index.model.ts';
import { actionLedgerRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { demand, ledgerMode, recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { openValues, seal } from './capture.service.ts';
import { loadSilo, open, person, requireSiloes, siloesEnabled, type Context, type SiloesDeps } from './deps.service.ts';

type Mode = 'off' | 'references' | 'values';
type Column = 'prior_values' | 'new_values';

export const CAPTURE_LEDGER_DISCLOSURE = 'Switching the Action ledger on keeps a copy of every executed Action in this Capture Silo, in this cell: '
  + 'one row per object, with the Action type, the people who proposed and approved it, the fields written and the outcome. With values, '
  + 'the copy holds the values before and after each write as well, encrypted. The receipt in Silo remains the record; the copy carries the '
  + 'markings of what it describes, keeps to this Silo\'s retention, and is removed when the Silo is purged.';

const binding = (organisationId: string, ledgerId: string, column: Column): ValueBinding =>
  ({ table: 'siloes.action_ledger', organisation_id: organisationId, ledger_id: ledgerId, column });

/** Where the cell has no Warehouse, a Capture Silo holds the ledger; elsewhere the Warehouse does. */
const heldHere = (deps: Pick<SiloesDeps, 'ledgerInCapture'>): boolean => deps.ledgerInCapture === true;

export async function setCaptureActionLedger(deps: SiloesDeps, ctx: Context, siloId: string, mode: Mode, acknowledged: boolean)
  : Promise<{ siloId: string; mode: Mode; disclosure: string }> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.enable', 'siloes.not_permitted');
  person(ctx);
  if (mode !== 'off' && !heldHere(deps)) {
    throw new AppError('conflict', 'this cell keeps the Action ledger in a Warehouse', { code: 'siloes.ledger_in_warehouse' });
  }
  if (mode !== 'off' && !acknowledged) {
    throw new AppError('validation', 'read and acknowledge the Action ledger disclosure first', {
      code: 'siloes.ledger_disclosure', details: { disclosure: CAPTURE_LEDGER_DISCLOSURE },
    });
  }
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = await loadSilo(db, siloId, 'capture');
    if (mode !== 'off') open(silo);
    if (ledgerMode(silo) === mode) return;
    await siloRepo.update(db, silo.id, {
      actionLedgerEnabledAt: mode === 'off' ? null : new Date(deps.now()).toISOString(), actionLedgerIncludeValues: mode === 'off' ? null : mode === 'values',
      version: String(Number(silo.version) + 1),
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: mode === 'off' ? 'ledger_disabled' : 'ledger_enabled', resource: { type: 'silo', id: silo.id },
      ...(mode === 'off' ? {} : { detail: { values: mode === 'values' } }), service: 'siloes-capture',
    });
  }).catch((error: unknown) => {
    // siloes_one_ledger: one Silo holds an organisation's ledger.
    if (error instanceof AppError && error.details['sqlstate'] === '23505') {
      throw new AppError('conflict', 'another Silo already holds this organisation\'s Action ledger', { code: 'siloes.ledger_elsewhere' });
    }
    throw error;
  });
  return { siloId, mode, disclosure: CAPTURE_LEDGER_DISCLOSURE };
}

/** The organisation's Capture Silo holding the ledger, live, where Siloes are on. */
async function holder(deps: SiloesDeps, ctx: Context): Promise<Silo | undefined> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (!await siloesEnabled(db, ctx.request.organisationId!)) return undefined;
    const silo = await siloRepo.findLedgerHolder(db);
    return silo?.kind === 'capture' && silo.status === 'active' ? silo : undefined;
  }, { readOnly: true });
}

export async function writeCaptureLedger(deps: SiloesDeps, ctx: Context, receiptId: string, rows: readonly LedgerRow[])
  : Promise<{ written: number; mode: Mode }> {
  const silo = await holder(deps, ctx);
  if (silo === undefined) return { written: 0, mode: 'off' };
  const mode = ledgerMode(silo);
  const organisationId = silo.organisationId;
  const values = mode === 'values';
  const items: { binding: ValueBinding; value: unknown }[] = [];
  const at = new Map<string, number>();
  if (values) {
    for (const r of rows) {
      for (const [column, value] of [['prior_values', r.priorValues], ['new_values', r.newValues]] as const) {
        if (value === null) continue;
        at.set(`${r.ledgerId}/${column}`, items.length);
        items.push({ binding: binding(organisationId, r.ledgerId, column), value });
      }
    }
  }
  const sealed = items.length === 0 ? [] : await seal(deps.services, ctx, items);
  const sealedOf = (ledgerId: string, column: Column): Buffer | null => {
    const i = at.get(`${ledgerId}/${column}`);
    return i === undefined ? null : sealed[i]!;
  };
  const written = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const n = await actionLedgerRepo.insertMissing(db, rows.map((r) => ({
      ledgerId: r.ledgerId, organisationId, siloId: silo.id, mutationId: r.mutationId, receiptId: r.receiptId, commitId: r.commitId,
      actionType: r.actionType, genericEdit: r.genericEdit, riskClass: r.riskClass, objectType: r.objectType, objectId: r.objectId,
      connectionId: r.connectionId, operation: r.operation, fields: r.fields,
      priorValues: sealedOf(r.ledgerId, 'prior_values'), newValues: sealedOf(r.ledgerId, 'new_values'),
      proposer: r.proposer, approvers: r.approvers, selfApproved: r.selfApproved, origin: r.origin, outcome: r.outcome,
      revertsMutationId: r.revertsMutationId, proposedAt: r.proposedAt, executedAt: r.executedAt, markingIds: r.markingIds,
    })));
    if (n > 0) {
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'ledger_row_written', resource: { type: 'silo', id: silo.id }, detail: { rows: n, receipt_id: receiptId }, service: 'siloes-capture',
      });
    }
    return n;
  });
  return { written, mode };
}

export async function purgeCaptureLedgerValues(deps: SiloesDeps, ctx: Context, receiptIds: readonly string[]): Promise<{ rows: number }> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const rows = await actionLedgerRepo.clearValues(db, receiptIds);
    if (rows > 0) {
      const silo = await siloRepo.findLedgerHolder(db);
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'ledger_purged', resource: silo === undefined ? null : { type: 'silo', id: silo.id },
        detail: { reason: 'receipt_purge', receipts: receiptIds.length, rows, receipts_kept: true }, service: 'siloes-capture',
      });
    }
    return { rows };
  });
}

const cursorOf = (r: Pick<ActionLedger, 'executedAt' | 'ledgerId'>): string => Buffer.from(JSON.stringify([r.executedAt, r.ledgerId])).toString('base64url');

function fromCursor(cursor: string | undefined): { executedAt: string; ledgerId: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const [executedAt, ledgerId] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    if (typeof executedAt === 'string' && !Number.isNaN(Date.parse(executedAt)) && /^[0-9a-f-]{36}$/.test(ledgerId)) return { executedAt, ledgerId };
  } catch { /* refused below */ }
  throw new AppError('validation', 'that cursor is not one this list gave', { code: 'siloes.bad_cursor' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listCaptureLedger(deps: SiloesDeps, ctx: Context, siloId: string, q: {
  receiptId?: string | undefined; objectId?: string | undefined; cursor?: string | undefined; limit: number;
}): Promise<{ mode: Mode; rows: CaptureLedgerRow[]; withheld: number; next: string | null }> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', 'siloes.not_permitted');
  const after = fromCursor(q.cursor);
  const { silo, rows } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = await loadSilo(db, siloId, 'capture');
    return { silo, rows: await actionLedgerRepo.page(db, { siloId, receiptId: q.receiptId, objectId: q.objectId, after, limit: q.limit + 1 }) };
  }, { readOnly: true });
  const page = rows.slice(0, q.limit);
  const next = rows.length > q.limit ? cursorOf(page.at(-1)!) : null;

  // The reader's own access: every marking on a row satisfied, and its object type visible.
  const markings = [...new Set(page.flatMap((r) => r.markingIds))];
  const types = [...new Set(page.map((r) => r.objectType).filter((t) => UUID.test(t)))];
  const access = page.length === 0 ? undefined : await deps.services.call(resolveAccess, { body: { markings, objectTypes: types } },
    { request: ctx.request, correlationId: ctx.correlationId });
  // Only what policy answered as held is shown: a denial, or a marking it did not answer for, withholds.
  const satisfied = new Set(access?.markings.filter((m) => m.satisfied).map((m) => m.id) ?? []);
  const visible = new Set(access?.objectTypes.filter((t) => t.visible).map((t) => t.id) ?? []);
  const shown = access?.decision !== 'allow' ? []
    : page.filter((r) => r.markingIds.every((m) => satisfied.has(m)) && visible.has(r.objectType));

  const sealed: { binding: ValueBinding; sealed: Buffer }[] = [];
  for (const r of shown) {
    if (r.priorValues !== null) sealed.push({ binding: binding(r.organisationId, r.ledgerId, 'prior_values'), sealed: r.priorValues });
    if (r.newValues !== null) sealed.push({ binding: binding(r.organisationId, r.ledgerId, 'new_values'), sealed: r.newValues });
  }
  const opened = sealed.length === 0 ? [] : await openValues(deps.services, ctx, sealed);
  let i = 0;
  const take = (present: boolean): Record<string, never> | null => (present ? opened[i++] as Record<string, never> : null);
  return {
    mode: ledgerMode(silo),
    rows: shown.map((r) => ({
      ledgerId: r.ledgerId, mutationId: r.mutationId, receiptId: r.receiptId, commitId: r.commitId, actionType: r.actionType, genericEdit: r.genericEdit,
      riskClass: r.riskClass, objectType: r.objectType, objectId: r.objectId, connectionId: r.connectionId, operation: r.operation, fields: r.fields,
      priorValues: take(r.priorValues !== null), newValues: take(r.newValues !== null),
      proposer: r.proposer, approvers: r.approvers, selfApproved: r.selfApproved, origin: r.origin, outcome: r.outcome,
      revertsMutationId: r.revertsMutationId, proposedAt: r.proposedAt, executedAt: r.executedAt, markingIds: r.markingIds,
      valuesClearedAt: r.valuesClearedAt, recordedAt: r.recordedAt,
    })),
    withheld: page.length - shown.length,
    next,
  };
}
