// The mutation path (spec 43): intent, resolve, policy gate, plan, read prior state, preview
// diff, approval (contracts/approvals), execute, verify, receipt; revert is a mutation too
// (contracts/revert).
//
// A mutation is one execution of a confirmed Action type with concrete parameter values
// against a resolved set of records. Proposing it runs every stage up to the preview and
// requests approval; nothing is written until the chain is satisfied. A stage that refuses
// leaves nothing written and records the stage and the check that failed (43.10 refused).
//
// The preview and receipt hold record values (prior and proposed): a member sees them when
// they proposed the mutation or may approve it. Everything else here is references and
// counts.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const MUTATION_STATUSES = [
  'previewed', 'awaiting_approval', 'approved', 'canary', 'executing', 'completed', 'completed_with_divergence', 'partially_failed',
  'failed', 'refused', 'rejected', 'expired',
] as const;
export const TERMINAL_STATUSES = ['completed', 'completed_with_divergence', 'partially_failed', 'failed', 'refused', 'rejected', 'expired'] as const;

export const objectReference = z.strictObject({
  connectionId: z.uuid(),
  /** The record's identifier in that source. */
  reference: z.string().min(1).max(500),
});
export type ObjectReference = z.infer<typeof objectReference>;

/**
 * The generic governed edit (spec 42.9): what silo.edit changes, compiled into its own
 * definition for this mutation. Set or clear properties of the records named (update),
 * give the properties of a new record (create), or delete the records named. Values are
 * record values: sealed with the mutation, never in its manifest.
 */
export const genericEdit = z.strictObject({
  objectTypeId: z.uuid(),
  operation: z.enum(['update', 'create', 'delete']),
  set: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.json()).default({}),
  clear: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).max(50).default([]),
}).superRefine((e, ctx) => {
  const set = Object.keys(e.set);
  if (set.length + e.clear.length > 50) ctx.addIssue({ code: 'custom', path: ['set'], message: 'at most 50 properties in one edit' });
  if (e.operation === 'update' && set.length + e.clear.length === 0) ctx.addIssue({ code: 'custom', path: ['set'], message: 'an update sets or clears a property' });
  if (e.operation === 'create' && (set.length === 0 || e.clear.length > 0)) ctx.addIssue({ code: 'custom', path: ['set'], message: 'a create gives the new record\'s properties and clears none' });
  if (e.operation === 'delete' && set.length + e.clear.length > 0) ctx.addIssue({ code: 'custom', path: ['set'], message: 'a delete names no properties' });
  for (const p of e.clear) if (p in e.set) ctx.addIssue({ code: 'custom', path: ['clear'], message: `${p} is either set or cleared` });
});
export type GenericEditInput = z.input<typeof genericEdit>;

/** An Action of a confirmed type, or the generic governed edit (its type may be named or left to Silo). */
const actionOrEdit = (b: { actionTypeId?: string | undefined; edit?: unknown; parameters: Record<string, unknown> }, ctx: z.RefinementCtx) => {
  if (b.actionTypeId === undefined && b.edit === undefined) ctx.addIssue({ code: 'custom', path: ['actionTypeId'], message: 'name the Action type, or give a generic edit' });
  if (b.edit !== undefined && Object.keys(b.parameters).length > 0) ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'a generic edit\'s values are in its edit' });
};

/** The branch simulation an approver sees with a promoted proposal (39.8): references and counts. */
export const branchSimulation = z.strictObject({
  runId: z.uuid().nullable(),
  graphVersion: z.int().nullable(),
  reachedHard: z.int().min(0),
  reachedSoft: z.int().min(0),
  stopped: z.int().min(0),
});

/** A scenario branch's staged Action entering the mutation path (spec 39.8). */
export const promotion = z.strictObject({
  scenarioId: z.uuid(),
  branchId: z.uuid(),
  stagedActionId: z.uuid(),
  /** Properties a person took as current on a conflicted record: not written there. */
  keepCurrent: z.array(z.strictObject({
    connectionId: z.uuid(), reference: z.string().min(1).max(500), property: z.string().min(1).max(200),
  })).max(10_000).default([]),
  /** Rows across everything promoted together: the bulk guardrails count them all, so promoting together never lowers an approval. */
  rowsTogether: z.int().min(1).max(10_000_000),
  simulation: branchSimulation,
});
export type Promotion = z.infer<typeof promotion>;

export const previewRow = z.object({
  objectId: z.uuid(),
  connectionId: z.uuid(),
  entityReference: z.string(),
  operation: z.enum(['create', 'update_full', 'update_partial', 'delete', 'upsert', 'custom']),
  /** A custom operation: the custom action invoked. */
  customAction: z.string().optional(),
  /**
   * A custom action's effect is read after it runs: its record-level row (field null) shows
   * the inputs sent; each field it declares it changes shows the prior value, proposed unknown.
   */
  proposedUnknown: z.boolean().optional(),
  /** Source field; null for a record-level row (a create's or delete's whole record). */
  field: z.string().nullable(),
  prior: z.json(),
  proposed: z.json(),
  /** Absent before; a create's prior, a delete's proposed. */
  priorAbsent: z.boolean(),
  proposedAbsent: z.boolean(),
});
export type PreviewRow = z.infer<typeof previewRow>;

export const preview = z.object({
  actionTypeVersionId: z.uuid(),
  riskClass: z.enum(['data', 'bulk', 'external', 'physical']),
  rows: z.array(previewRow),
  /** Objects excluded under a partial resolution policy, with why. */
  excluded: z.array(z.object({ connectionId: z.uuid(), reference: z.string(), reason: z.string() })),
  /** More than one connection: not atomic, and the product says so (45.2). */
  nonAtomic: z.boolean(),
  /** Fields revert will not restore (unreadable or source-managed), per connection. */
  notRestored: z.array(z.object({ connectionId: z.uuid(), field: z.string() })),
  /** A webhook's records: effect where its target declares a status endpoint, otherwise delivery, not effect (20.4). */
  sideEffects: z.array(z.object({ kind: z.string(), physical: z.boolean(), records: z.enum(['delivery', 'effect']).optional() })),
  /** The blast radius walk (43.7) is not built in this release; the preview says so rather than show it as complete. */
  /** 10,000 rows or more: a sample is written and verified first, then confirmed before the rest (43.9, 45.4). */
  canary: z.object({ sample: z.int() }).nullable().optional(),
  /** What else the change touches (43.7): references and counts, never values; a bounded walk says at which hop. */
  blastRadius: z.object({
    computed: z.boolean(),
    reason: z.string().nullable(),
    hops: z.int().optional(),
    boundedAtHop: z.int().nullable().optional(),
    counts: z.record(z.enum(['dependent_record', 'cascading_delete', 'broken_relationship', 'ontology_link']), z.int()).optional(),
    relationships: z.array(z.object({
      via: z.string(), kind: z.enum(['dependent_record', 'cascading_delete', 'broken_relationship', 'ontology_link']),
      connectionId: z.uuid(), sourceObject: z.string(), count: z.int(), bounded: z.boolean(),
    })).optional(),
  }),
  /**
   * A physical Action (47.3): each node, its value now and proposed, its allow-listed range, step
   * and interval, the connection's writes a minute and the last write, and the statement no
   * configuration can remove or reword.
   */
  physical: z.object({
    statement: z.string(),
    /** A dry run (47.5): each node's simulator counterpart is written, never production. */
    dryRun: z.boolean().optional(),
    nodes: z.array(z.object({
      connectionId: z.uuid(), reference: z.string(), field: z.string(), nodeAddress: z.string(), current: z.json(), proposed: z.json(),
      simulatorAddress: z.string().nullable().optional(),
      /** A command (47.1): its custom action, the node or topic it goes to, and for MQTT the payload as published; proposed is its inputs. */
      command: z.string().optional(), payload: z.string().optional(),
      /** A physical webhook (47.1): the target it posts to; nodeAddress and command are its action's name, proposed the parameters. */
      endpointId: z.uuid().optional(),
      range: z.object({ min: z.string(), max: z.string() }).nullable(), maxStep: z.string().nullable(), minIntervalSeconds: z.int(),
      maxPerMinute: z.int().nullable(), lastWrittenAt: z.string().nullable(),
    })),
  }).optional(),
});
export type Preview = z.infer<typeof preview>;

export const mutationView = z.object({
  id: z.uuid(),
  status: z.enum(MUTATION_STATUSES),
  origin: z.enum(['action', 'ask', 'cron', 'scenario_promotion', 'revert']),
  actionTypeVersionId: z.uuid(),
  /** A generic governed edit (42.9), or a revert of one: a write made outside a confirmed Action type. */
  genericEdit: z.boolean(),
  /** A physical Action's dry run (47.5), and the dry run a proposal followed where one is required. */
  dryRun: z.boolean(),
  dryRunReceiptId: z.uuid().nullable(),
  objectTypeId: z.uuid(),
  riskClass: z.enum(['data', 'bulk', 'external', 'physical']),
  rowCount: z.int(),
  resolutionPolicy: z.enum(['strict', 'partial']),
  proposerMembershipId: z.uuid().nullable(),
  executionSeparated: z.boolean(),
  refusedStage: z.string().nullable(),
  refusalReason: z.string().nullable(),
  diffHash: z.string().nullable(),
  createdAt: z.string(),
  previewedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** Record values: only for the proposer and those who may approve. */
  preview: preview.nullable(),
  chain: z.object({
    id: z.uuid(), status: z.enum(['pending', 'approved', 'rejected', 'expired']), approvalsRequired: z.int(), approvalsReceived: z.int(),
    expiresAt: z.string(),
  }).nullable(),
  executions: z.array(z.object({
    connectionId: z.uuid(), phase: z.enum(['canary', 'full']), status: z.enum(['pending', 'executing', 'succeeded', 'partially_succeeded', 'failed']),
    recordsAttempted: z.int(), recordsApplied: z.int(), error: z.string().nullable(),
  })),
  verification: z.object({ verified: z.int(), diverged: z.int(), failed: z.int() }),
  /**
   * While a canary waits for confirmation (45.4): what its random sample showed, and what that
   * says about the rest: with 95% confidence, the share of the remaining records that would
   * diverge or fail is below the bound, assuming they behave like the sample (a uniform prior).
   */
  canaryEvidence: z.object({
    sampled: z.int(), problems: z.int(), problemRateUpper95: z.number(), randomSample: z.literal(true), statement: z.string(),
  }).nullable(),
  receiptId: z.uuid().nullable(),
  /** A revert's own change: the revert it carries out, whose conflicts a person decides (D265). */
  revertId: z.uuid().nullable(),
  /** A promotion's origin (39.8): its scenario, branch and staged Action, and the branch simulation. References only. */
  promotion: z.object({
    scenarioId: z.uuid(), branchId: z.uuid(), stagedActionId: z.uuid(), rowsTogether: z.int(), keptCurrent: z.int(), simulation: branchSimulation,
  }).nullable(),
});
export type MutationView = z.infer<typeof mutationView>;

const mutationId = z.strictObject({ mutationId: z.uuid() });

export const proposeMutation = defineContract({
  service: 'actions', name: 'proposeMutation', method: 'POST', path: '/v1/mutations',
  callers: ['gateway', 'ask', 'scheduler', 'studio', 'simulation'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    /** Absent for a generic edit: silo.edit. */
    actionTypeId: z.uuid().optional(),
    parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.json()).default({}),
    /** The generic governed edit (42.9), instead of parameters to a confirmed type. */
    edit: genericEdit.optional(),
    /** The records the Action changes or deletes. */
    objects: z.array(objectReference).max(10_000).default([]),
    /** A create's connection; by default the first permitted connection that declares create. */
    createOn: z.uuid().optional(),
    /** Strict refuses if any object is unresolved; partial proceeds without it. Chosen per mutation (43.3). */
    resolutionPolicy: z.enum(['strict', 'partial']).default('strict'),
    /** The person's own words. Stored encrypted, purged with the receipt. */
    intent: z.string().trim().min(1).max(4_000).optional(),
    /** A scenario branch's staged Action (39.8): from simulation only, and simulation only promotes. */
    promotion: promotion.optional(),
    /** A physical Action's dry run (47.5): the full path against the simulator nodes, nothing written to production. */
    dryRun: z.literal(true).optional(),
    /** Where the organisation requires one (47.5): the dry run's receipt this proposal follows. */
    dryRunReceiptId: z.uuid().optional(),
  }).superRefine(actionOrEdit),
  response: mutationView,
  status: 201,
  maxBodyBytes: 2 * 1024 * 1024,
});

/** One touched field of a checked target: its property, the value now and the value the Action would write. Record values. */
export const checkedField = z.object({
  field: z.string(),
  /** The ontology property mapped to the field; null for a link's key or a custom action's change. */
  property: z.string().nullable(),
  current: z.json(),
  /** Null with stagedUnknown where a custom action's effect is known only once it runs. */
  staged: z.json(),
  stagedUnknown: z.boolean(),
});

export const checkOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('refused'), stage: z.string(), reason: z.string() }),
  z.object({
    outcome: z.literal('checked'),
    actionTypeVersionId: z.uuid(),
    objectTypeId: z.uuid(),
    riskClass: z.enum(['data', 'bulk', 'external', 'physical']),
    physical: z.boolean(),
    targets: z.array(z.object({
      objectId: z.uuid(), connectionId: z.uuid(), reference: z.string(), operation: z.enum(['create', 'update_full', 'update_partial', 'delete', 'upsert', 'custom']),
      fields: z.array(checkedField),
    })),
    excluded: z.array(z.object({ connectionId: z.uuid().nullable(), reference: z.string(), reason: z.string() })),
  }),
]);
export type CheckOutcome = z.infer<typeof checkOutcome>;

/**
 * Staging an Action in a scenario branch (spec 39.8): every stage of a proposal up to the
 * values (intent, resolve, the policy gate, the prior state of the touched fields), in check
 * mode. A refusal is answered, not recorded; nothing is written and no approval requested.
 */
export const checkMutation = defineContract({
  service: 'actions', name: 'checkMutation', method: 'POST', path: '/v1/mutation-checks', callers: ['simulation'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    actionTypeId: z.uuid().optional(),
    parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.json()).default({}),
    edit: genericEdit.optional(),
    objects: z.array(objectReference).max(10_000).default([]),
    createOn: z.uuid().optional(),
    resolutionPolicy: z.enum(['strict', 'partial']).default('strict'),
  }).superRefine(actionOrEdit),
  response: checkOutcome,
  maxBodyBytes: 2 * 1024 * 1024,
});

/**
 * Who last changed these objects' fields through Silo since a time, by completed mutations
 * (39.8: who changed a conflicted property, where knowable). References only.
 */
export const listRecentWrites = defineContract({
  service: 'actions', name: 'listRecentWrites', method: 'POST', path: '/v1/mutation-writes/queries', callers: ['simulation'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectIds: z.array(z.uuid()).min(1).max(10_000), since: z.string().min(1).max(40) }),
  response: z.object({
    writes: z.array(z.object({
      objectId: z.uuid(), field: z.string(), mutationId: z.uuid(), proposerMembershipId: z.uuid().nullable(), completedAt: z.string(),
    })),
  }),
  maxBodyBytes: 512 * 1024,
});

export const getMutation = defineContract({
  service: 'actions', name: 'getMutation', method: 'GET', path: '/v1/mutations/:mutationId',
  callers: ['gateway', 'approvals', 'revert', 'ask', 'studio'],
  context: 'organisation', idempotency: 'none',
  params: mutationId,
  response: mutationView,
});

export const listMutations = defineContract({
  service: 'actions', name: 'listMutations', method: 'GET', path: '/v1/mutations', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    status: z.enum(MUTATION_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ mutations: z.array(mutationView) }),
});

/**
 * Executes an approved mutation (spec 45.1). Where execution is not separated, the approvals
 * service calls this as the final approver; where it is, a holder of mutation.execute who is
 * not the proposer does. Answered at once; the writes continue, and the mutation's status and
 * receipt show the outcome.
 */
export const executeMutation = defineContract({
  service: 'actions', name: 'executeMutation', method: 'POST', path: '/v1/mutations/:mutationId/execute',
  callers: ['approvals', 'gateway'],
  shed: 'action_execution', context: 'organisation', idempotency: 'none',
  params: mutationId,
  response: mutationView,
  status: 202,
});

/**
 * The remainder of a canaried mutation (45.4): by the executor, or the final approver where
 * execution is not separated, after seeing every diverged or failed sample record; `seen`
 * states how many of each they saw, and must match.
 */
export const confirmCanary = defineContract({
  service: 'actions', name: 'confirmCanary', method: 'POST', path: '/v1/mutations/:mutationId/canary-confirmation', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: mutationId,
  body: z.strictObject({ seen: z.strictObject({ diverged: z.int().min(0), failed: z.int().min(0) }) }),
  response: mutationView,
  status: 202,
});

// ----------------------------------------------------------------------------- receipts and history

export const receiptView = z.object({
  id: z.uuid(),
  mutationId: z.uuid(),
  documentHash: z.string(),
  revertsReceiptId: z.uuid().nullable(),
  createdAt: z.string(),
  retentionUntil: z.string(),
  purgedAt: z.string().nullable(),
  /** Value-free: kept after purge. */
  summary: z.record(z.string(), z.json()),
  /** The canonical document, opened: record values. Only for those who may read the mutation's preview; null after purge. */
  document: z.record(z.string(), z.json()).nullable(),
});
export type ReceiptView = z.infer<typeof receiptView>;

export const getReceipt = defineContract({
  service: 'actions', name: 'getReceipt', method: 'GET', path: '/v1/receipts/:receiptId', callers: ['gateway', 'revert'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ receiptId: z.uuid() }),
  response: receiptView,
  maxBodyBytes: 1024,
});

export const commitView = z.object({
  id: z.uuid(),
  objectId: z.uuid(),
  mutationId: z.uuid(),
  receiptId: z.uuid(),
  parentCommitId: z.uuid().nullable(),
  revertsCommitId: z.uuid().nullable(),
  authorMembershipId: z.uuid(),
  approverMembershipIds: z.array(z.uuid()),
  fieldsChanged: z.array(z.string()),
  outcome: z.enum(['verified', 'diverged', 'failed']),
  committedAt: z.string(),
});

/** The object's log of governed changes, newest first (spec 46.2). */
export const listObjectCommits = defineContract({
  service: 'actions', name: 'listObjectCommits', method: 'GET', path: '/v1/objects/:objectId/commits', callers: ['gateway', 'revert'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectId: z.uuid() }),
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: z.object({ commits: z.array(commitView) }),
});

// ----------------------------------------------------------------------------- Crons (43.11)

/**
 * A Cron's mutate action (spec 40.5, 43.11): its principal proposes the Action type over the
 * objects its question returned, under the authorisation its action names. In execute mode
 * the mutation runs at once where it is within every bound, and otherwise waits for approval.
 */
export const proposeCronMutation = defineContract({
  service: 'actions', name: 'proposeCronMutation', method: 'POST', path: '/v1/cron-mutations',
  callers: ['scheduler'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    automationId: z.uuid(),
    actionId: z.uuid(),
    objects: z.array(objectReference).min(1).max(10_000),
  }),
  response: z.object({
    mutationId: z.uuid(),
    status: z.string(),
    cronMode: z.enum(['propose', 'execute_within_bounds']).nullable(),
    refusalReason: z.string().nullable(),
  }),
  maxBodyBytes: 4 * 1024 * 1024,
});
