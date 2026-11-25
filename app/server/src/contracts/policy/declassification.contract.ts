// Declassification (spec 58.9): removing a direct marking from a resource is a governed
// Action, never an edit. It is previewed (the markings before and after, how many members
// would gain access, and, applied downstream, how many artefacts would lose the inherited
// marking), approved, recorded, and revertible.
//
// - Requesting needs marking.declassify and satisfying the marking; no service principal
//   requests or approves one.
// - It needs at least one approver other than the requester who also satisfies the
//   marking; self-approval is never available, whatever the approval policies say. The
//   approval chain is the approvals service's like any other; the approver decides it
//   there with the diff hash shown here.
// - Once approved, policy removes the marking from the resource; applied downstream, each
//   artefact that inherited it loses it unless another input still carries it (the union is
//   re-evaluated per node). Reverting puts back exactly what was removed.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { MARKABLE } from './governance.contract.ts';

export const DECLASSIFICATION_STATUSES = ['awaiting_approval', 'approved', 'executed', 'rejected', 'expired', 'reverted'] as const;

export const declassificationView = z.object({
  id: z.uuid(),
  markingId: z.uuid(),
  resource: z.object({ type: z.enum(MARKABLE), id: z.uuid() }),
  applyDownstream: z.boolean(),
  justification: z.string(),
  requestedBy: z.uuid(),
  status: z.enum(DECLASSIFICATION_STATUSES),
  preview: z.object({
    /** The resource's direct markings now, and after. */
    markingsBefore: z.array(z.uuid()),
    markingsAfter: z.array(z.uuid()),
    /** Active members who satisfy every other marking on the resource but not this one. */
    readersGainingAccess: z.int(),
    /** Applied downstream: artefacts that would lose the inherited marking (none keep it by another path). */
    downstreamLosing: z.int(),
  }),
  approvalChainId: z.uuid(),
  /** What an approver approves (hex SHA-256 of the request and its preview). */
  diffHash: z.string(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
  revertedAt: z.string().nullable(),
});
export type DeclassificationView = z.infer<typeof declassificationView>;

const declassificationId = z.strictObject({ declassificationId: z.uuid() });

export const requestDeclassification = defineContract({
  service: 'policy', name: 'requestDeclassification', method: 'POST', path: '/v1/declassifications', callers: ['gateway'],
  // Each call is a new request with its own chain.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    markingId: z.uuid(),
    resource: z.strictObject({ type: z.enum(MARKABLE), id: z.uuid() }),
    justification: z.string().trim().min(1).max(2_000),
    applyDownstream: z.boolean().default(false),
  }),
  response: declassificationView,
  status: 201,
  maxBodyBytes: 8_192,
});

export const getDeclassification = defineContract({
  service: 'policy', name: 'getDeclassification', method: 'GET', path: '/v1/declassifications/:declassificationId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: declassificationId,
  response: declassificationView,
});

export const listDeclassifications = defineContract({
  service: 'policy', name: 'listDeclassifications', method: 'GET', path: '/v1/declassifications', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ declassifications: z.array(declassificationView) }),
});

/** Called by approvals as the final approver: removes the marking once the chain is approved. Repeating it changes nothing. */
export const executeDeclassification = defineContract({
  service: 'policy', name: 'executeDeclassification', method: 'POST', path: '/v1/declassifications/:declassificationId/execution',
  callers: ['approvals'],
  context: 'organisation', idempotency: 'none',
  params: declassificationId,
  response: declassificationView,
});

/** Puts back exactly what the declassification removed. Needs what requesting needs. */
export const revertDeclassification = defineContract({
  service: 'policy', name: 'revertDeclassification', method: 'POST', path: '/v1/declassifications/:declassificationId/revert', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: declassificationId,
  response: declassificationView,
});
