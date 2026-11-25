// Receipt purge (spec 46.1, 48.2, 65.3, 70). Receipts are the one place record values persist
// by default, under retention and purge. Purging a mutation's values nulls every value it
// kept (receipt document; intent, diff and manifest values; prior states; read-back values; a
// revert's conflict values) and fails a webhook delivery still waiting with its payload
// cleared, while the hash, references and counts stay. Only silo_migrate may null them (the
// tables' purge guards), so the work runs through one narrow definer function that purges
// exactly one mutation in the caller's organisation.
//
// - Retention: a sweep purges every receipt past its retention_until (730 days), and the
//   rest of its mutation's values with it. Each is receipt_purged with the reason.
// - On request: a person holding silo.purge asks for one receipt, or every receipt of a
//   commit on an object (an erasure), as every wipe is asked (70.3): through the
//   organisation's default approval policy where one requires approvals (approvers hold
//   silo.purge and are not the requester), otherwise at once. purge_requested, then
//   purge_approved (or purge_rejected), then receipt_purged for each receipt and
//   purge_completed with the counts.
// - The Action ledger (48.2): where the Warehouse's ledger holds values, those of the
//   purged receipts' rows are cleared too; references and outcomes stay, as in the receipt.

import { createHash } from 'node:crypto';
import type { ReceiptPurgeView } from '../../contracts/actions/receiptPurge.contract.ts';
import { purgeCaptureLedgerValues } from '../../contracts/siloes/captureLedger.contract.ts';
import { purgeActionLedgerValues } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ReceiptPurge } from '../../models/action/receiptPurge.model.ts';
import {
  actionCommitRepo, approvalChainRepo, approvalPolicyRepo, approvalStepRepo, ledgerCopyRepo, receiptPurgeRepo, receiptRepo,
} from '../../repos/action/index.repo.ts';
import { outboxRepo } from '../../repos/platform/outbox.repo.ts';
import { actionLedgerRepo, warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import type { StoredLedgerEntry } from '../../contracts/platform/purgeLedger.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { storedConditions } from '../approvals/snapshot.service.ts';
import { demand, memberOf, openValues, sealValues, type Context, type WriteBackDeps } from './deps.service.ts';
import { bindings } from './store.service.ts';
import { recordActionEvent } from './events.service.ts';

const CHAIN_HOURS = 24;
const CONDITION = 'receipt_purge';
/** Receipts one request reaches at most; an object with more is purged in parts. */
export const MAX_RECEIPTS = 10_000;
/** Receipts one retention pass purges per organisation. */
const SWEEP_BATCH = 500;

type Target = { scope: 'receipt'; receiptId: string } | { scope: 'object'; objectId: string };

/** The purge an approver quotes: its hash. */
export function receiptPurgeDocument(r: Pick<ReceiptPurge, 'id' | 'organisationId' | 'scope' | 'receiptId' | 'objectId'>): Buffer {
  return createHash('sha256').update(canonicalJson({ purge: r.id, organisation: r.organisationId, scope: r.scope, receipt: r.receiptId, object: r.objectId })).digest();
}

/** The organisation default approval policy decides whether a purge needs a chain, as for a Silo wipe. */
async function approvalsRequired(db: Queryable): Promise<{ required: number; hours: number; sources: string[] }> {
  const defaults = (await approvalPolicyRepo.listLive(db)).filter((p) => p.connectionId === null && p.scopeId === null && p.approvalsRequired > 0);
  return {
    required: defaults.length === 0 ? 0 : Math.max(...defaults.map((p) => p.approvalsRequired)),
    hours: Math.min(CHAIN_HOURS, ...defaults.map((p) => p.expiryHours)),
    sources: defaults.map((p) => p.id),
  };
}

/** The mutations whose values a purge reaches: the receipt's, or those of every commit on the object. */
async function mutationsOf(db: Queryable, r: Pick<ReceiptPurge, 'scope' | 'receiptId' | 'objectId'>): Promise<{ mutationId: string; receiptId: string }[]> {
  if (r.scope === 'receipt') {
    const receipt = await receiptRepo.findById(db, r.receiptId!);
    return receipt === undefined ? [] : [{ mutationId: receipt.mutationId, receiptId: receipt.id }];
  }
  return actionCommitRepo.receiptsOnObject(db, r.objectId!, MAX_RECEIPTS + 1);
}

function view(r: ReceiptPurge, reached: number): ReceiptPurgeView {
  return {
    id: r.id, scope: r.scope as 'receipt' | 'object', receiptId: r.receiptId, objectId: r.objectId, status: r.status as ReceiptPurgeView['status'],
    approvalChainId: r.approvalChainId, documentHash: r.approvalChainId === null ? null : receiptPurgeDocument(r).toString('hex'),
    requestedBy: r.requestedBy, requestedAt: r.requestedAt, receipts: r.receiptsPurged ?? reached, ledgerRows: r.ledgerRows, completedAt: r.completedAt,
    failureStage: r.failureStage,
  };
}

export function createReceiptPurges(deps: WriteBackDeps, now: () => number = Date.now) {
  const control = deps.databases.pool('control');

  /** Purges one mutation's values in its organisation; the receipt ids it purged. */
  async function purgeMutation(request: RequestContext, correlationId: string, mutationId: string, reason: 'retention' | 'requested', purgeId: string | null)
    : Promise<string[]> {
    return inTransaction(control, request, async (db) => {
      const purged = await receiptRepo.purgeMutationValues(db, mutationId);
      for (const receiptId of purged.receiptIds) {
        await recordActionEvent(db, {
          organisationId: request.organisationId!, correlationId, request, service: 'actions', resource: { type: 'receipt', id: receiptId },
          detail: {
            mutation_id: mutationId, reason, purge_id: purgeId, prior_states: purged.priorStates, verifications: purged.verifications,
            conflicts: purged.conflicts, deliveries_failed: purged.deliveriesFailed,
          },
          event: 'receipt_purged',
        });
      }
      return purged.receiptIds;
    });
  }

  /**
   * The Action ledger's values for these receipts, wherever they are held (48.2): in the
   * Warehouse where the organisation has one, and in a Capture Silo's copy (D205), where any
   * row of them still holds values. A cell without a Warehouse is never asked to clear one.
   */
  /**
   * A ledger copy still owed for a purged receipt (48.2) keeps its references and outcomes and
   * loses its values, as the rows already written do: opened, its values cleared, sealed again.
   */
  async function stripOwedCopies(request: RequestContext, correlationId: string, receiptIds: readonly string[]): Promise<void> {
    const ctx: Context = { request, correlationId };
    for (const id of receiptIds) {
      await inTransaction(control, request, async (db) => {
        const copy = await ledgerCopyRepo.claim(db, id);
        if (copy === undefined) return;
        const [rows] = await openValues(deps, ctx, [{ binding: bindings.ledgerCopy(id), sealed: copy.rowsSealed }]);
        const stripped = (rows as Record<string, unknown>[]).map((r) => ({ ...r, priorValues: null, newValues: null }));
        const [sealed] = await sealValues(deps, ctx, [{ binding: bindings.ledgerCopy(id), value: stripped }]);
        await ledgerCopyRepo.update(db, id, { rowsSealed: sealed! });
      });
    }
  }

  async function purgeLedger(request: RequestContext, correlationId: string, receiptIds: readonly string[]): Promise<number> {
    let rows = 0;
    await stripOwedCopies(request, correlationId, receiptIds);
    for (let i = 0; i < receiptIds.length; i += 1_000) {
      const chunk = receiptIds.slice(i, i + 1_000);
      const held = await inTransaction(control, request, async (db) => ({
        warehouse: await warehouseProjectRepo.findByOrganisationId(db, request.organisationId!) !== undefined,
        capture: await actionLedgerRepo.holdsValuesFor(db, chunk),
      }), { readOnly: true });
      if (held.warehouse) rows += (await deps.services.call(purgeActionLedgerValues, { body: { receiptIds: chunk } }, { request, correlationId })).rows;
      if (held.capture) rows += (await deps.services.call(purgeCaptureLedgerValues, { body: { receiptIds: chunk } }, { request, correlationId })).rows;
    }
    return rows;
  }

  async function run(organisationId: string, purgeId: string, correlationId: string): Promise<void> {
    const request: RequestContext = { organisationId };
    const claimed = await inTransaction(control, request, async (db) => {
      const r = await receiptPurgeRepo.findById(db, purgeId);
      if (r === undefined || r.status !== 'approved') return undefined;
      return { purge: (await receiptPurgeRepo.update(db, r.id, { status: 'running' }))!, targets: await mutationsOf(db, r) };
    });
    if (claimed === undefined) return;
    const { purge, targets } = claimed;
    const as: RequestContext = { organisationId, membershipId: purge.requestedBy };
    let stage = 'receipts';
    try {
      const receiptIds: string[] = [];
      for (const t of targets.slice(0, MAX_RECEIPTS)) receiptIds.push(...await purgeMutation(as, correlationId, t.mutationId, 'requested', purge.id));
      stage = 'ledger';
      const ledgerRows = await purgeLedger(as, correlationId, receiptIds);
      await inTransaction(control, request, async (db) => {
        await receiptPurgeRepo.update(db, purge.id, { status: 'completed', receiptsPurged: receiptIds.length, ledgerRows, completedAt: new Date(now()).toISOString() });
        // The purge ledger (8.2; D251): kept outside this database, so a restore purges again what came back.
        if (receiptIds.length > 0) await outboxRepo.recordPurge(db, { organisationId, correlationId, entry: { kind: 'receipt_values', purgeId: purge.id, receiptIds } });
        await recordActionEvent(db, {
          organisationId, correlationId, request: as, service: 'actions', resource: { type: 'organisation', id: organisationId }, event: 'purge_completed',
          detail: { purge_id: purge.id, scope: `receipt_${purge.scope}`, receipts: receiptIds.length, ledger_rows: ledgerRows, receipts_kept_hashes: true },
        });
      });
    } catch (error) {
      deps.logger.failure('a receipt purge failed', error, { event: 'action.receipt_purge_failed', organisationId });
      await inTransaction(control, request, (db) => receiptPurgeRepo.update(db, purge.id, { status: 'failed', failureStage: stage }));
    }
  }

  return {
    async request(ctx: Context, target: Target): Promise<ReceiptPurgeView> {
      const { organisationId, membershipId } = memberOf(ctx, 'a receipt purge');
      await demand(deps, ctx, 'silo.purge', undefined, 'action.not_permitted');
      const at = new Date(now());
      const { row, reached } = await inTransaction(control, ctx.request, async (db) => {
        const id = uuidv7();
        const draft = { id, organisationId, scope: target.scope, receiptId: target.scope === 'receipt' ? target.receiptId : null, objectId: target.scope === 'object' ? target.objectId : null };
        if (target.scope === 'receipt' && (await receiptRepo.findById(db, target.receiptId))?.purgedAt != null) {
          throw new AppError('conflict', 'this receipt is already purged', { code: 'receipt.already_purged' });
        }
        const targets = await mutationsOf(db, draft);
        if (targets.length === 0) {
          throw new AppError('not_found', target.scope === 'receipt' ? 'no such receipt' : 'no receipt names this object', { code: 'receipt.not_found' });
        }
        if (targets.length > MAX_RECEIPTS) {
          throw new AppError('capacity', 'more receipts name this object than one purge takes', { code: 'receipt.purge_bounded', details: { limit: MAX_RECEIPTS } });
        }
        const approvals = await approvalsRequired(db);
        const chainId = approvals.required > 0 ? uuidv7() : null;
        let r = await receiptPurgeRepo.insert(db, { ...draft, requestedBy: membershipId });
        if (chainId !== null) {
          const condition = {
            id: CONDITION, count: approvals.required, qualification: 'any_permitted' as const, qualifyingRoleId: null, requiresAdmin: false,
            selfApprovalPermitted: false, connectionIds: [], sources: approvals.sources,
          };
          await approvalChainRepo.insert(db, {
            id: chainId, organisationId, subjectKind: 'receipt_purge', receiptPurgeId: id, requesterMembershipId: membershipId,
            policySnapshot: { conditions: storedConditions([condition]), sequential: false, subject: 'receipt_purge', scope: target.scope } as never,
            diffHash: receiptPurgeDocument(r), approvalsRequired: approvals.required, status: 'pending',
            expiresAt: new Date(at.getTime() + approvals.hours * 3_600_000).toISOString(),
          });
          for (let n = 0; n < approvals.required; n++) {
            await approvalStepRepo.insert(db, { id: uuidv7(), organisationId, chainId, sequence: null, qualifyingRule: CONDITION, offeredAt: at.toISOString() });
          }
          r = (await receiptPurgeRepo.update(db, id, { approvalChainId: chainId }))!;
        } else {
          // No chain configured: the requester is the approver.
          r = (await receiptPurgeRepo.update(db, id, { status: 'approved', decidedAt: at.toISOString() }))!;
        }
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', resource: { type: 'organisation', id: organisationId },
          event: 'purge_requested',
          detail: { purge_id: id, scope: `receipt_${target.scope}`, receipts: targets.length, approvals_required: approvals.required },
        });
        return { row: r, reached: targets.length };
      });
      if (row.status === 'approved') await run(organisationId, row.id, ctx.correlationId);
      return this.get(ctx, row.id).then((v) => ({ ...v, receipts: v.status === 'completed' ? v.receipts : reached }));
    },

    async get(ctx: Context, purgeId: string): Promise<ReceiptPurgeView> {
      await demand(deps, ctx, 'silo.purge', undefined, 'action.not_permitted');
      return inTransaction(control, ctx.request, async (db) => {
        const r = await receiptPurgeRepo.findById(db, purgeId);
        if (r === undefined) throw new AppError('not_found', 'no such receipt purge', { code: 'receipt.purge_not_found' });
        return view(r, r.receiptsPurged ?? (await mutationsOf(db, r)).length);
      }, { readOnly: true });
    },

    /** The approval watcher: approved chains run their purge; rejected or expired ones end it. */
    async advance(correlationId: string): Promise<number> {
      const open = await inTransaction(control, {}, (db) => receiptPurgeRepo.openAcrossCell(db, 200), { readOnly: true });
      let ran = 0;
      for (const o of open) {
        const request: RequestContext = { organisationId: o.organisationId };
        const next = await inTransaction(control, request, async (db) => {
          const r = await receiptPurgeRepo.findById(db, o.id);
          if (r === undefined) return undefined;
          if (r.status === 'approved') return r;
          const chain = r.approvalChainId === null ? undefined : await approvalChainRepo.findById(db, r.approvalChainId);
          if (chain === undefined || chain.status === 'pending') return undefined;
          const as = { organisationId: r.organisationId, membershipId: r.requestedBy };
          const decidedAt = new Date(now()).toISOString();
          if (chain.status === 'approved') {
            const approvers = (await approvalStepRepo.listByChain(db, chain.id)).flatMap((s) => (s.approverMembershipId === null ? [] : [s.approverMembershipId]));
            const updated = (await receiptPurgeRepo.update(db, r.id, { status: 'approved', decidedAt }))!;
            await recordActionEvent(db, {
              organisationId: r.organisationId, correlationId, request: as, service: 'actions', resource: { type: 'organisation', id: r.organisationId },
              event: 'purge_approved', detail: { purge_id: r.id, approvers },
            });
            return updated;
          }
          await receiptPurgeRepo.update(db, r.id, { status: 'rejected', decidedAt });
          await recordActionEvent(db, {
            organisationId: r.organisationId, correlationId, request: as, service: 'actions', resource: { type: 'organisation', id: r.organisationId },
            event: 'purge_rejected', detail: { purge_id: r.id, chain: chain.status },
          });
          return undefined;
        });
        if (next !== undefined) {
          await run(next.organisationId, next.id, correlationId);
          ran += 1;
        }
      }
      return ran;
    },

    /** One organisation's receipts past their retention: purged with the rest of their mutations' values. */
    async sweepOrganisation(organisationId: string, correlationId: string): Promise<{ receipts: number; ledgerRows: number }> {
      const request: RequestContext = { organisationId };
      const cutoff = new Date(now()).toISOString();
      let receipts = 0;
      let ledgerRows = 0;
      for (;;) {
        const due = await inTransaction(control, request, (db) => receiptRepo.pastRetention(db, cutoff, SWEEP_BATCH), { readOnly: true });
        if (due.length === 0) break;
        const purged: string[] = [];
        for (const d of due) purged.push(...await purgeMutation(request, correlationId, d.mutationId, 'retention', null));
        receipts += purged.length;
        ledgerRows += await purgeLedger(request, correlationId, purged);
        if (due.length < SWEEP_BATCH) break;
      }
      return { receipts, ledgerRows };
    },

    /** Every organisation with receipts past their retention. */
    async sweepAll(correlationId: string): Promise<number> {
      const organisations = await inTransaction(control, {}, (db) => receiptRepo.organisationsPastRetention(db, new Date(now()).toISOString()), { readOnly: true });
      let receipts = 0;
      for (const organisationId of organisations) {
        try {
          receipts += (await this.sweepOrganisation(organisationId, correlationId)).receipts;
        } catch (error) {
          if (!isAppError(error)) throw error;
          deps.logger.failure('receipts could not be swept; the next pass tries again', error, { event: 'action.receipt_retention_failed', organisationId });
        }
      }
      return receipts;
    },
  };
}

export type ReceiptPurges = ReturnType<typeof createReceiptPurges>;


/**
 * Replays receipt purges from the purge ledger after a restore (spec 8.2, 12.5; D251): each
 * receipt's mutation has its values purged again, as the purge did; a receipt the restore does
 * not hold is skipped. Retention purges need no ledger: the sweep runs again by itself.
 */
export async function replayReceiptValues(deps: WriteBackDeps, entries: readonly StoredLedgerEntry[]): Promise<{ replayed: number; skipped: number }> {
  const control = deps.databases.pool('control');
  let replayed = 0;
  let skipped = 0;
  for (const stored of entries) {
    if (stored.entry.kind !== 'receipt_values') { skipped += 1; continue; }
    const ids = stored.entry.receiptIds;
    const done = await inTransaction(control, { organisationId: stored.organisationId }, async (db) => {
      let found = 0;
      for (const id of ids) {
        const receipt = await receiptRepo.findById(db, id);
        if (receipt === undefined) continue;
        await receiptRepo.purgeMutationValues(db, receipt.mutationId);
        found += 1;
      }
      return found;
    });
    if (done === 0) skipped += 1; else replayed += 1;
  }
  return { replayed, skipped };
}
