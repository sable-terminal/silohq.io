// Receipts and the object log (spec 46.1, 46.2). The receipt is the artefact a reviewer
// reads: its value-free summary for anyone in the organisation who may see the mutation, its
// document (opened, values) for those who may read the mutation's preview. The hash in the
// receipt row is the one in the audit ledger; recomputing it from the opened document shows
// whether the receipt was altered.

import type { ReceiptView } from '../../contracts/actions/mutation.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { actionCommitRepo, mutationRepo, receiptRepo } from '../../repos/action/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { openValues, type Context, type WriteBackDeps } from './deps.service.ts';
import { bindings, mayReadValues } from './store.service.ts';

export function createReceipts(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');
  return {
    async get(ctx: Context, receiptId: string): Promise<ReceiptView> {
      const { receipt, mutation } = await inTransaction(control, ctx.request, async (db) => {
        const receipt = await receiptRepo.findById(db, receiptId);
        if (!receipt) throw new AppError('not_found', 'no such receipt', { code: 'receipt.not_found' });
        return { receipt, mutation: (await mutationRepo.findById(db, receipt.mutationId))! };
      }, { readOnly: true });
      const readable = receipt.document !== null && await mayReadValues(deps, ctx, mutation);
      const document = readable
        ? (await openValues(deps, ctx, [{ binding: bindings.receipt(receipt.id), sealed: receipt.document! }]))[0] as Record<string, never>
        : null;
      return {
        id: receipt.id, mutationId: receipt.mutationId, documentHash: receipt.documentHash.toString('hex'), revertsReceiptId: receipt.revertsReceiptId,
        createdAt: receipt.createdAt, retentionUntil: receipt.retentionUntil, purgedAt: receipt.purgedAt,
        summary: receipt.referenceSummary as Record<string, never>, document,
      };
    },

    async commits(ctx: Context, objectId: string, limit: number) {
      const rows = await inTransaction(control, ctx.request, (db) => actionCommitRepo.listByObject(db, objectId, limit), { readOnly: true });
      return rows.map((c) => ({
        id: c.id, objectId: c.objectId, mutationId: c.mutationId, receiptId: c.receiptId, parentCommitId: c.parentCommitId, revertsCommitId: c.revertsCommitId,
        authorMembershipId: c.authorMembershipId, approverMembershipIds: c.approverMembershipIds, fieldsChanged: c.fieldsChanged, outcome: c.outcome,
        committedAt: c.committedAt,
      }));
    },
  };
}

export type Receipts = ReturnType<typeof createReceipts>;
