// Revert (spec 46.3 to 46.7): a new commit computed three-way at the time of asking, with no
// time window. For each record the original mutation applied, the current state is read and
// compared with the post-write state (what verification observed) and the prior state the
// receipt holds (the proposed reverted state):
// - current equals post-write: revert cleanly;
// - current already equals prior: nothing written, reported as already reverted;
// - current differs from post-write: a conflict per field, which a person decides: restore
//   prior, keep current, or exclude the record;
// - an update whose record has since been deleted: reported, not recreated (only touched
//   fields were stored);
// - a create whose record is unchanged: deleted, its full readable record captured, so the
//   revert is revertible; changed since: a conflict;
// - a delete whose record is absent: recreated from the full readable prior record (under
//   the original identifier where the source takes one; otherwise the new identifier is
//   recorded as a remapping); present again: a conflict.
// A revert is a mutation (46.5): the same policy gate, the same approval chain (requested once
// every conflict is decided), its own receipt linked to the one it reverts. Any holder of
// mutation.revert may request it; a suspended account can still revert.

import { z } from 'zod';
import { mutationView } from '../actions/mutation.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const CONFLICT_KINDS = ['field_changed', 'record_missing', 'record_reappeared', 'created_record_changed'] as const;
export const CONFLICT_DECISIONS = ['restore_prior', 'keep_current', 'exclude_record'] as const;

export const revertView = z.object({
  id: z.uuid(),
  revertedReceiptId: z.uuid(),
  newMutationId: z.uuid(),
  scope: z.enum(['full', 'partial_objects', 'partial_connections', 'succeeded_half']),
  conflictCount: z.int(),
  /** Records already in their prior state, written nothing. */
  alreadyReverted: z.int(),
  conflicts: z.array(z.object({
    id: z.uuid(),
    objectId: z.uuid(),
    entityReference: z.string(),
    field: z.string().nullable(),
    kind: z.enum(CONFLICT_KINDS),
    /** Record values, for those who may read the revert's preview. */
    postWriteValue: z.json().nullable(),
    currentValue: z.json().nullable(),
    changedBy: z.string().nullable(),
    decision: z.enum(CONFLICT_DECISIONS).nullable(),
  })),
  mutation: mutationView,
});
export type RevertView = z.infer<typeof revertView>;

export const requestRevert = defineContract({
  service: 'revert', name: 'requestRevert', method: 'POST', path: '/v1/reverts', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    receiptId: z.uuid(),
    /** The whole mutation; or, after a partial failure, exactly the records that succeeded. */
    scope: z.enum(['full', 'succeeded_half']).default('full'),
  }),
  response: revertView,
  status: 201,
});

export const getRevert = defineContract({
  service: 'revert', name: 'getRevert', method: 'GET', path: '/v1/reverts/:revertId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ revertId: z.uuid() }),
  response: revertView,
});

export const decideRevertConflicts = defineContract({
  service: 'revert', name: 'decideRevertConflicts', method: 'POST', path: '/v1/reverts/:revertId/decisions', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ revertId: z.uuid() }),
  body: z.strictObject({
    decisions: z.array(z.strictObject({ conflictId: z.uuid(), decision: z.enum(CONFLICT_DECISIONS) })).min(1).max(10_000),
  }),
  response: revertView,
});
