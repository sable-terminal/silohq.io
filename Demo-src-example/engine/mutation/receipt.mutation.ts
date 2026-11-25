import type { MutationManifest } from './resolve.mutation';
import type { MutationPreview, PriorState, Target } from './preview.mutation';
import type { ChainPolicy } from './policy.mutation';
import type { Verification } from './execute.mutation';

/**
 * Mutations §12 — the receipt.
 *
 * "The receipt is the artefact a reviewer reads. It answers what changed, who
 * authorised it, and what it was before, without anything being reconstructed
 * afterwards."
 *
 * ASSEMBLED HERE, ONCE, FROM WHAT THE STAGES BEFORE IT STORED. Nothing in it is
 * recomputed: the diff is the preview as previewed, the approvals are the rows
 * the approvers wrote, the verifications are what the source said when it was
 * read back. This function only arranges them.
 */

export type ReceiptExecution = {
  connectionId: string;
  phase: 'canary' | 'remainder' | 'full';
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';
  records: number;
  applied: number;
  failed: number;
  attemptedAt: Date;
  completedAt: Date | null;
  error: string | null;
};

export type ReceiptDecision = {
  sequence: number;
  approver: string;
  decision: 'approve' | 'reject';
  selfApproval: boolean;
  roleIds: string[];
  comment: string | null;
  decidedAt: Date;
};

export type Receipt = {
  mutationId: string;
  /** §12 — in the user's own words. */
  intent: string;
  manifest: MutationManifest;
  proposedBy: string;
  proposedAt: string;
  outcome: 'executed' | 'partially_executed' | 'failed';
  /** §10 — said on every receipt that touched more than one system. */
  atomic: boolean;
  entitySet: Target[];
  priorStates: PriorState[];
  /** The preview exactly as it was approved, and its digest. */
  diff: MutationPreview;
  diffDigest: string;
  approval: {
    policy: ChainPolicy;
    requestedAt: string;
    decidedAt: string | null;
    decisions: Array<Omit<ReceiptDecision, 'decidedAt'> & { decidedAt: string }>;
  } | null;
  executedBy: string | null;
  canary: { confirmedBy: string; confirmedAt: string } | null;
  executions: Array<Omit<ReceiptExecution, 'attemptedAt' | 'completedAt'> & { attemptedAt: string; completedAt: string | null }>;
  verifications: Array<Verification & { connectionId: string }>;
  /** §12 — "Lineage for every value: source system, field path, connector version." */
  lineage: Array<{
    connectionId: string;
    system: string;
    object: string;
    connectorVersion: number;
    fields: Array<{ field: string; column: string }>;
  }>;
  /** §10 — what a revert could offer, stated when the receipt is made. */
  revertable: { available: boolean; records: number; because?: string };
};

export function receiptOf(input: {
  mutation: {
    id: string;
    intent: string;
    manifest: MutationManifest;
    proposedBy: string;
    createdAt: Date;
    executedBy: string | null;
    canaryConfirmedBy: string | null;
    canaryConfirmedAt: Date | null;
  };
  preview: MutationPreview;
  previewDigest: string;
  targets: Target[];
  priorStates: PriorState[];
  chain: { policy: ChainPolicy; createdAt: Date; decidedAt: Date | null; decisions: ReceiptDecision[] } | null;
  executions: ReceiptExecution[];
  verifications: Array<Verification & { connectionId: string }>;
  outcome: Receipt['outcome'];
}): Receipt {
  const iso = (at: Date | null) => (at ? at.toISOString() : null);

  const appliedRecords = new Set(
    input.verifications
      .filter((one) => one.outcome !== 'failed')
      .map((one) => `${one.connectionId}\u0000${one.ref}`),
  );

  const lineage = input.preview.connections.map((connection) => {
    const fields = new Map<string, string>();
    for (const change of input.preview.changes.filter((one) => one.connectionId === connection.connectionId)) {
      for (const field of change.fields) fields.set(field.field, field.column);
    }
    return {
      connectionId: connection.connectionId,
      system: connection.name,
      object: connection.object,
      connectorVersion: connection.connectorVersion,
      fields: [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, column]) => ({ field, column })),
    };
  });

  return {
    mutationId: input.mutation.id,
    intent: input.mutation.intent,
    manifest: input.mutation.manifest,
    proposedBy: input.mutation.proposedBy,
    proposedAt: input.mutation.createdAt.toISOString(),
    outcome: input.outcome,
    atomic: input.preview.atomic,
    entitySet: input.targets,
    priorStates: input.priorStates,
    diff: input.preview,
    diffDigest: input.previewDigest,
    approval: input.chain
      ? {
          policy: input.chain.policy,
          requestedAt: input.chain.createdAt.toISOString(),
          decidedAt: iso(input.chain.decidedAt),
          decisions: input.chain.decisions.map((one) => ({ ...one, decidedAt: one.decidedAt.toISOString() })),
        }
      : null,
    executedBy: input.mutation.executedBy,
    canary:
      input.mutation.canaryConfirmedBy && input.mutation.canaryConfirmedAt
        ? { confirmedBy: input.mutation.canaryConfirmedBy, confirmedAt: input.mutation.canaryConfirmedAt.toISOString() }
        : null,
    executions: input.executions.map((one) => ({
      ...one,
      attemptedAt: one.attemptedAt.toISOString(),
      completedAt: iso(one.completedAt),
    })),
    verifications: input.verifications,
    lineage,
    revertable:
      input.mutation.manifest.operation === 'delete'
        ? {
            available: false,
            records: 0,
            because: 'A deleted record cannot be recreated: the whole record was never read.',
          }
        : { available: appliedRecords.size > 0, records: appliedRecords.size },
  };
}
