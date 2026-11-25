// Crons (spec 40): a saved question, a schedule, a condition, and the actions taken when the
// condition holds, run without anyone present. The service is scheduler; the tables keep the
// automation prefix.
//
// A Cron runs as its own service principal of kind automation (spec 40.6), created with it.
// The principal executes and never authorises: its permissions are the intersection of what
// the Cron is granted (read access to the connections its question reads, recorded in
// automation.automation_connections, and CRON_PRINCIPAL_PERMISSIONS) and what its owner
// holds at run time, markings included. When the owner loses a grant, the Cron loses it.
//
// Built (spec 40.12 steps 1 to 4, 6 and 7): schedules in the organisation's time zone, result
// and value conditions with run state, finding conditions over the detectors' findings,
// composites to three levels, notify, report, escalate and mutate actions, overlap and missed-run rules, failure policy, and the pauses on a
// halted connection, an owner who left and a suspended billing status.
//
// A mutate action (40.5, 43.11) proposes, or executes within bounds, a confirmed Action type
// over the objects the question returns. It is authorised by the person who attaches it
// (mutation.propose; execute also automation.execute), recorded as the authorising member
// of every mutation it makes. Execute names, at creation and never changed by the Cron, a
// maximum row count, the properties it may write, the connections it may reach and an
// expiry; it is never available for a physical Action type.
//
// A change trigger (40.2, step 5) watches a saved object set (filter or explicit, on a
// type): it evaluates when a watched property's field changes or an object enters or
// leaves, coalesced over its window, through the change streams every source of the type
// must have. A finding condition reads the detectors' findings (recognition) each run; the
// Cron still runs its question, and the condition decides whether its actions are taken.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { shareGrantee, viewShareView } from '../workspace/sharing.contract.ts';

/** What a Cron's principal is granted beyond its connections: what its actions need (report exports). */
export const CRON_PRINCIPAL_PERMISSIONS = ['file.export'] as const;

/** What a Cron with a live mutate authorisation is granted besides (spec 40.5): proposing, on the connections the authorisation names. */
export const CRON_MUTATE_PERMISSIONS = ['mutation.propose'] as const;

const name = z.string().trim().min(1).max(200);
/** A standard five-field expression: minute, hour, day of month, month, day of week. */
const cronExpression = z.string().trim().regex(/^\S+(\s+\S+){4}$/, 'a schedule is five fields: minute hour day-of-month month day-of-week')
  .max(200);

// ----------------------------------------------------------------------------- conditions

const RESULT_OPERATORS = ['returned_rows', 'returned_none', 'count_crossed', 'differs_from_previous'] as const;
const VALUE_OPERATORS = ['above', 'below', 'changed_by_proportion', 'unchanged_for'] as const;

/** The one figure a value condition reads: a measure of a single-group answer, or a property of a single object. */
export const figure = z.union([
  z.strictObject({ measure: z.string().min(1).max(63) }),
  z.strictObject({ property: z.string().min(1).max(63) }),
]);
export type Figure = z.infer<typeof figure>;

export const resultCondition = z.strictObject({
  kind: z.literal('result'),
  operator: z.enum(RESULT_OPERATORS),
  /** count_crossed: the threshold, and the side the count crosses to. */
  threshold: z.number().int().min(0).max(1_000_000_000).optional(),
  direction: z.enum(['above', 'below']).optional(),
}).refine((c) => (c.operator === 'count_crossed') === (c.threshold !== undefined && c.direction !== undefined),
  'count_crossed names a threshold and a direction; no other result condition does');

export const valueCondition = z.strictObject({
  kind: z.literal('value'),
  operator: z.enum(VALUE_OPERATORS),
  figure,
  /** above, below: the owner's threshold. */
  threshold: z.number().finite().optional(),
  /** changed_by_proportion: e.g. 0.1 for ten per cent. */
  proportion: z.number().positive().max(1000).optional(),
  /** unchanged_for: how long the figure has stayed the same. */
  hours: z.number().int().min(1).max(24 * 366).optional(),
}).superRefine((c, ctx) => {
  const need = { above: 'threshold', below: 'threshold', changed_by_proportion: 'proportion', unchanged_for: 'hours' }[c.operator];
  for (const field of ['threshold', 'proportion', 'hours'] as const) {
    if ((field === need) !== (c[field] !== undefined)) {
      ctx.addIssue({ code: 'custom', path: [field], message: field === need ? `${c.operator} needs ${field}` : `${c.operator} takes no ${field}` });
    }
  }
});

/**
 * Finding conditions (spec 40.3), over what the detectors raised since the last run, read as
 * the Cron's own principal with no Lens (a finding silenced in the owner's Lens still counts):
 * raised (the named detector raised anything on the named type), score_above (a finding of
 * theirs scored above the threshold), recurred (a finding on the same objects as one that had
 * gone away). The first run counts from the Cron's creation.
 */
export const findingCondition = z.strictObject({
  kind: z.literal('finding'),
  operator: z.enum(['raised', 'score_above', 'recurred']),
  detectorId: z.uuid(),
  objectTypeId: z.uuid(),
  threshold: z.number().finite().optional(),
}).refine((c) => (c.operator === 'score_above') === (c.threshold !== undefined), 'score_above names a threshold; no other finding condition does');

export type ConditionInput =
  | z.infer<typeof resultCondition> | z.infer<typeof valueCondition> | z.infer<typeof findingCondition>
  | { kind: 'composite'; combinator: 'AND' | 'OR'; operands: ConditionInput[] };

export const conditionInput: z.ZodType<ConditionInput> = z.lazy(() => z.union([
  resultCondition, valueCondition, findingCondition,
  z.strictObject({ kind: z.literal('composite'), combinator: z.enum(['AND', 'OR']), operands: z.array(conditionInput).min(2).max(10) }),
]));

// ----------------------------------------------------------------------------- actions

export const actionInput = z.discriminatedUnion('kind', [
  /** A Home item for the owner and the named members: the Cron, the condition and counts, never values (spec 40.4). */
  z.strictObject({ kind: z.literal('notify'), recipients: z.array(z.uuid()).max(20).default([]) }),
  /** An export placed in Files, under the Cron's access at run time, frozen. */
  z.strictObject({ kind: z.literal('report'), format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'), folderId: z.uuid().optional() }),
  /** Raised to one membership or one scope for a decision; stays open until acknowledged. */
  z.strictObject({
    kind: z.literal('escalate'), membershipId: z.uuid().optional(), scopeId: z.uuid().optional(),
    /** How long the named member has to acknowledge it; 72 hours unless set. */
    acknowledgeWithinHours: z.number().int().min(1).max(24 * 30).optional(),
  })
    .refine((a) => (a.membershipId === undefined) !== (a.scopeId === undefined), 'an escalation names one membership or one scope'),
  /**
   * Propose (default) or execute within bounds (40.5) a confirmed Action type over the objects
   * the question returns. The type's object type is the question's, a single-source type whose
   * key the question selects; its parameters need no value (a Cron stores none).
   */
  z.strictObject({
    kind: z.literal('mutate'), actionTypeId: z.uuid(), mode: z.enum(['propose', 'execute']).default('propose'),
    /**
     * The Action type's parameter values, set by the person attaching the action and
     * unchangeable by the Cron (40.5). Record values: sealed with the action, never shown back.
     */
    parameters: recordValue(z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.json())).optional(),
    /** execute: rows per run (over 100 it falls back to propose). */
    maxRows: z.int().min(1).max(9_999).optional(),
    /** execute: the properties it may write, by API name. */
    properties: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).min(1).max(200).optional(),
    /** execute: the connections it may reach. */
    connectionIds: z.array(z.uuid()).min(1).max(20).optional(),
    /** execute: when the authorisation ends. */
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }).superRefine((a, ctx) => {
    const bounds = [a.maxRows, a.properties, a.connectionIds, a.expiresAt];
    if (a.mode === 'execute' && bounds.some((b) => b === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'execute names a maximum row count, the properties, the connections and an expiry' });
    }
    if (a.mode === 'propose' && bounds.some((b) => b !== undefined)) ctx.addIssue({ code: 'custom', message: 'only execute takes bounds' });
  }),
]);
export type ActionInput = z.input<typeof actionInput>;

export const failurePolicy = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('notify_and_continue') }),
  z.strictObject({ mode: z.literal('pause_after'), failures: z.number().int().min(1).max(20) }),
]);
export type FailurePolicy = z.infer<typeof failurePolicy>;

// ----------------------------------------------------------------------------- views

export const CRON_STATUSES = ['active', 'paused', 'stopped'] as const;
export const PAUSED_REASONS = ['manual', 'repeated_failure', 'connection_halted', 'owner_removed', 'billing_suspended',
  'authorisation_expired'] as const;

export interface ConditionView {
  id: string;
  kind: 'result' | 'value' | 'finding' | 'composite';
  operator: string | null;
  combinator: 'AND' | 'OR' | null;
  target: unknown;
  value: unknown;
  operands: ConditionView[];
}

export const conditionView: z.ZodType<ConditionView> = z.lazy(() => z.object({
  id: z.uuid(),
  kind: z.enum(['result', 'value', 'finding', 'composite']),
  operator: z.string().nullable(),
  combinator: z.enum(['AND', 'OR']).nullable(),
  target: z.unknown(),
  value: z.unknown(),
  operands: z.array(conditionView),
}));

export const cronActionView = z.object({
  id: z.uuid(),
  sequence: z.int(),
  kind: z.enum(['notify', 'report', 'mutate', 'escalate']),
  configuration: z.record(z.string(), z.unknown()),
  escalateMembershipId: z.uuid().nullable(),
  escalateScopeId: z.uuid().nullable(),
});

export const cronView = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerMembershipId: z.uuid(),
  servicePrincipalId: z.uuid(),
  savedViewId: z.uuid().nullable(),
  schedule: z.string().nullable(),
  timezone: z.string(),
  status: z.enum(CRON_STATUSES),
  pausedReason: z.enum(PAUSED_REASONS).nullable(),
  pausedAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  failurePolicy,
  condition: conditionView.nullable(),
  actions: z.array(cronActionView),
  /** The connections the question reads: a halted one pauses the Cron. */
  connectionIds: z.array(z.uuid()),
  createdAt: z.string(),
  version: z.int(),
});
export type CronView = z.infer<typeof cronView>;

export const runActionView = z.object({
  id: z.uuid(),
  sequence: z.int(),
  kind: z.enum(['notify', 'report', 'mutate', 'escalate']),
  outcome: z.enum(['succeeded', 'failed', 'skipped', 'proposed', 'executed', 'delivered']),
  /** Counts only, never values. */
  resultCounts: z.record(z.string(), z.unknown()).nullable(),
  fileId: z.uuid().nullable(),
  /** A mutate action: the mutation it proposed or executed. */
  mutationId: z.uuid().nullable(),
  escalatedMembershipId: z.uuid().nullable(),
  escalatedScopeId: z.uuid().nullable(),
  acknowledgedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const cronRunView = z.object({
  id: z.uuid(),
  trigger: z.enum(['schedule', 'change', 'manual']),
  status: z.enum(['running', 'completed', 'failed', 'skipped']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  conditionOutcome: z.enum(['met', 'not_met', 'indeterminate']).nullable(),
  skippedReason: z.string().nullable(),
  /** A redacted code, never a value. */
  error: z.string().nullable(),
  actions: z.array(runActionView),
});
export type CronRunView = z.infer<typeof cronRunView>;

// ----------------------------------------------------------------------------- endpoints

const CALLERS = ['gateway'] as const;
const byCron = z.strictObject({ cronId: z.uuid() });

export const createCron = defineContract({
  service: 'scheduler', name: 'createCron', method: 'POST', path: '/v1/crons', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name,
    /**
     * The saved question or object set re-run. Absent: a finding-only Cron (spec 40.3: "tell me
     * when this kind of problem appears", with no question to author), on a schedule, whose
     * condition is made of finding conditions and whose actions notify or escalate.
     */
    subject: z.union([z.strictObject({ savedViewId: z.uuid() }), z.strictObject({ objectSetId: z.uuid() })]).optional(),
    /** A schedule, or a watch (property identities, and the window changes coalesce over) on an object set subject. */
    trigger: z.union([
      z.strictObject({ schedule: cronExpression }),
      z.strictObject({ watch: z.strictObject({ properties: z.array(z.uuid()).max(64), windowSeconds: z.number().int().min(60) }) }),
    ]),
    condition: conditionInput.optional(),
    actions: z.array(actionInput).min(1).max(10),
    failurePolicy: failurePolicy.default({ mode: 'notify_and_continue' }),
  }),
  response: cronView, status: 201, maxBodyBytes: 32 * 1024,
});

export const listCrons = defineContract({
  service: 'scheduler', name: 'listCrons', method: 'GET', path: '/v1/crons', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  /** mine: the caller's own; managed: every Cron the caller may manage (automation.manage); shared: shared with the caller (40.8). */
  query: z.strictObject({ which: z.enum(['mine', 'managed', 'shared']).default('mine') }),
  response: z.object({ crons: z.array(cronView) }),
});

export const getCron = defineContract({
  // workspace: whether a person may follow the Cron (they must be able to read it).
  service: 'scheduler', name: 'getCron', method: 'GET', path: '/v1/crons/:cronId', callers: [...CALLERS, 'workspace'],
  context: 'organisation', idempotency: 'none', params: byCron, response: cronView,
});

export const pauseCron = defineContract({
  service: 'scheduler', name: 'pauseCron', method: 'POST', path: '/v1/crons/:cronId/pause', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byCron, response: cronView,
});

/** Resuming is its own governance action: never under an owner who left, never on a halted connection. */
export const resumeCron = defineContract({
  service: 'scheduler', name: 'resumeCron', method: 'POST', path: '/v1/crons/:cronId/resume', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byCron, response: cronView,
});

/** Stops the Cron for good and revokes its principal; its run history stays. */
export const deleteCron = defineContract({
  service: 'scheduler', name: 'deleteCron', method: 'DELETE', path: '/v1/crons/:cronId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byCron, response: cronView,
});

/** Runs the Cron now, as a manual trigger. Answers at once; the run is in the history. */
export const runCronNow = defineContract({
  service: 'scheduler', name: 'runCronNow', method: 'POST', path: '/v1/crons/:cronId/runs', callers: CALLERS,
  shed: 'cron', context: 'organisation', idempotency: 'none', params: byCron,
  response: z.object({ runId: z.uuid().nullable(), skipped: z.string().nullable() }), status: 202,
});

export const listCronRuns = defineContract({
  service: 'scheduler', name: 'listCronRuns', method: 'GET', path: '/v1/crons/:cronId/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byCron,
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ runs: z.array(cronRunView) }),
});

// ----------------------------------------------------------------------------- sharing (40.8)

/**
 * The owner shares a Cron as saved views are shared (spec 40.8), within the same sharing
 * policy: with a member, a scope or the organisation, for its visibility and run history,
 * never its authorisation. A sharee reads it and its runs; only the owner (or a manager)
 * changes it.
 */
export const shareCron = defineContract({
  service: 'scheduler', name: 'shareCron', method: 'PUT', path: '/v1/crons/:cronId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byCron,
  body: z.strictObject({ grantee: shareGrantee, expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: viewShareView,
});

export const revokeCronShare = defineContract({
  service: 'scheduler', name: 'revokeCronShare', method: 'POST', path: '/v1/crons/:cronId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ cronId: z.uuid(), shareId: z.uuid() }),
  response: viewShareView,
});

export const listCronShares = defineContract({
  service: 'scheduler', name: 'listCronShares', method: 'GET', path: '/v1/crons/:cronId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byCron,
  response: z.object({ shares: z.array(viewShareView) }),
});

/**
 * Runs that started after a moment, on the member's own Crons and on those they follow and
 * may still read: Home's "Crons that fired" (spec 33.7). A followed Cron they can no longer
 * read is left out.
 */
export const listFiredRuns = defineContract({
  service: 'scheduler', name: 'listFiredRuns', method: 'POST', path: '/v1/crons/fired-runs', callers: ['workspace'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    since: z.iso.datetime({ offset: true }),
    followedCronIds: z.array(z.uuid()).max(200),
    limit: z.int().min(1).max(100).default(20),
  }),
  response: z.object({
    runs: z.array(z.object({ cronId: z.uuid(), cronName: z.string(), owned: z.boolean(), run: cronRunView })),
    more: z.boolean(),
  }),
  maxBodyBytes: 16_384,
});

/** An escalation stays on Home and Governance until the named member, or a member of the named scope, acknowledges it. */
export const acknowledgeEscalation = defineContract({
  service: 'scheduler', name: 'acknowledgeEscalation', method: 'POST', path: '/v1/cron-escalations/:runActionId/acknowledgement',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runActionId: z.uuid() }),
  response: runActionView,
});
