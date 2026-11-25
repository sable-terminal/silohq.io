// The compile stage (spec 26): a question in the organisation's own words becomes a
// validated plan over the ontology, in this order and no other (26.2):
//
//   vocabulary → model → compile → plan → bounds → charge → execute
//
// - vocabulary: what this reader may see, resolved before any model call; what they cannot
//   see is never named, so it cannot enter a plan (26.3);
// - model: the question and the vocabulary through model-gateway, names and types only;
// - compile: schema validity and referential truth; a plan naming anything not offered is
//   refused, never repaired (26.5);
// - plan and bounds: the planner decomposes it and states its bounds (26.7, 26.10);
// - charge: metering, only once a plan exists, keyed so a retry never charges twice;
// - execute: the executor runs it.
//
// Structured callers (a saved view, an Explorer filter, a Studio widget, a Cron) enter at
// compile with a plan in structure: vocabulary still first, no model call, never metered.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { DATA_TYPES } from '../ontology/manifest.contract.ts';
import { queryResult, RUN_TIMEOUT_MS } from '../executor/result.contract.ts';
import { clarification, planExplanation, planParameters, queryPlan, refusal } from '../planner/plan.contract.ts';
import { duration } from '../simulation/graph.contract.ts';
import { FAILURE_FORMS } from '../simulation/scenario.contract.ts';

export const COMPILE_CLASSES = ['standard', 'advanced'] as const;

const charged = z.discriminatedUnion('charged', [
  z.object({ charged: z.literal(true), transactionId: z.string(), weight: z.string() }),
  z.object({ charged: z.literal(false), reason: z.enum(['never_metered', 'rephrase_window']) }),
]);

/** A deprecated element the plan uses (spec 25.7): still usable, with its replacement and retirement date. */
export const deprecationNotice = z.object({
  kind: z.literal('deprecated'),
  elementKind: z.enum(['object_type', 'link_type']),
  elementId: z.uuid(),
  apiName: z.string(),
  replacedById: z.uuid().nullable(),
  retireAfter: z.string().nullable(),
});
export type DeprecationNotice = z.infer<typeof deprecationNotice>;

const compiled = {
  planId: z.uuid(),
  plan: queryPlan,
  parameters: planParameters,
  compileClass: z.enum(COMPILE_CLASSES),
  /** Every compile that uses a deprecated element says so (spec 25.7). */
  notices: z.array(deprecationNotice).optional(),
  /**
   * The object types the question was compiled against, when the reader's vocabulary was
   * narrowed (decision 2026-11-15), and whether it was widened to all of it once.
   */
  narrowing: z.object({ objectTypeIds: z.array(z.uuid()), widened: z.boolean() }).optional(),
};

/**
 * A change the question asks for (spec 42.9), compiled, never executed: Ask turns it into a
 * draft a person submits through the mutation path. It names the object type, the operation,
 * the properties with the values written in the question (record values, the asker's own),
 * the plan that finds the records an update or delete changes (its values bound under the
 * request's binding), and how it would be made: the confirmed Action types that fit, each
 * with its parameters pre-filled (one is bound; several, the person chooses), or, where none
 * fits, the generic governed edit, where the organisation allows it.
 */
export const compiledIntent = z.object({
  objectTypeId: z.uuid(),
  operation: z.enum(['update', 'create', 'delete']),
  /** Property API names to the values written in the question. */
  set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  clear: z.array(z.string()),
  targetsPlanId: z.uuid().nullable(),
  candidates: z.array(z.object({
    actionTypeId: z.uuid(), actionTypeVersionId: z.uuid(), apiName: z.string(), displayName: z.string(),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })),
  /** None fits: silo.edit, with set and clear as its edit. */
  genericEdit: z.boolean(),
});
export type CompiledIntent = z.infer<typeof compiledIntent>;

/** A Cron asked for (36.4, 40): the schedule compile wrote, the result condition and the first action; never saved here. */
export const compiledSchedule = z.object({
  schedule: z.string(),
  condition: z.object({
    kind: z.literal('result'), operator: z.enum(['returned_rows', 'returned_none', 'differs_from_previous', 'count_crossed']),
    threshold: z.int().optional(), direction: z.enum(['above', 'below']).optional(),
  }).nullable(),
  action: z.enum(['notify', 'report']),
  asWritten: z.string(),
});
export type CompiledSchedule = z.infer<typeof compiledSchedule>;

export const compileOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('answer'), ...compiled, charge: charged, result: queryResult }),
  /** With execute false: compiled, bounded and charged, not run. */
  z.object({ outcome: z.literal('plan'), ...compiled, charge: charged, explanation: planExplanation }),
  z.object({ outcome: z.literal('refusal'), refusal }),
  z.object({ outcome: z.literal('clarification'), clarification }),
  /** Where the caller allows changes (intents): a change, compiled and charged, never executed (42.9). */
  z.object({ outcome: z.literal('intent'), intent: compiledIntent, charge: charged, compileClass: z.enum(COMPILE_CLASSES) }),
  /** Where the caller allows changes: a Cron asked for, its schedule written by compile, charged as a compile, never saved (36.4). */
  z.object({ outcome: z.literal('schedule'), schedule: compiledSchedule, charge: charged, compileClass: z.enum(COMPILE_CLASSES) }),
]);
export type CompileOutcome = z.infer<typeof compileOutcome>;

const CALLERS = ['gateway', 'ask', 'workspace', 'studio', 'scheduler', 'fde-orchestrator', 'render'] as const;

/** A failure stated in words (36.4 "Start a scenario", 39.4): its form and how long, as simulation states it; the objects are the asker's reference. */
export const compiledFailure = z.object({
  form: z.enum(FAILURE_FORMS),
  delay: duration.optional(),
  period: duration.optional(),
  capacityRemaining: z.number().gt(0).lt(1).optional(),
  /** The asker's words for it. */
  asWritten: z.string(),
});
export type CompiledFailure = z.infer<typeof compiledFailure>;

/**
 * Ask's start a scenario (36.4): the failure the question states, for an object type the
 * asker may see, compiled by the model in simulation's closed set of forms, checked as a
 * stated failure is, charged as a compile. Keyed: a retry is compiled and charged once.
 */
export const compileFailure = defineContract({
  service: 'compile', name: 'compileFailure', method: 'POST', path: '/v1/compilations/failures', callers: ['ask'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ question: z.string().trim().min(1).max(2_000), objectTypeId: z.uuid() }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('failure'), failure: compiledFailure, charge: charged }),
    z.object({ outcome: z.literal('refusal'), refusal }),
  ]),
  maxBodyBytes: 16 * 1024,
});
const purposeSessionIds = z.array(z.uuid()).max(16);

/** A question to an answer, a refusal or a clarification (spec 26.9). Keyed: the charge is. */
export const compileQuestion = defineContract({
  service: 'compile', name: 'compileQuestion', method: 'POST', path: '/v1/compilations',
  callers: CALLERS,
  // Compiled, then run within the executor's bound.
  timeoutMs: RUN_TIMEOUT_MS + 60_000,
  shed: 'compile', context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    /** Length-bounded: a model is charged by the token (spec 26.4). */
    question: z.string().trim().min(1).max(2_000),
    /** Compile against this version; main's head when absent. */
    ontologyVersionId: z.uuid().optional(),
    /**
     * Compile against this ontology branch's head (spec 25.3), for a holder of ontology.branch on
     * it. The answer says it was computed on a branch, and lineage records the branch.
     */
    branchId: z.uuid().optional(),
    /** Earlier plans in an Ask thread: their structure, never their results (spec 26.4). */
    priorPlanIds: z.array(z.uuid()).max(5).default([]),
    /** The earlier compile this rephrases: within the window it is not charged again (spec 73.2). */
    rephraseOf: z.uuid().optional(),
    /** Where the question is asked from (an Ask thread's scope, spec 33.6): its subject type, offered to the model first. */
    focus: z.strictObject({ objectTypeId: z.uuid() }).optional(),
    /**
     * A clarification answered (spec 26.9): the element chosen and the candidates it was
     * chosen over, which this compile leaves out of the vocabulary so the term means one thing.
     */
    chosen: z.strictObject({
      about: z.enum(['object_type', 'time_field', 'route', 'property']),
      elementId: z.uuid(),
      rejectedIds: z.array(z.uuid()).max(20),
    }).optional(),
    /**
     * Keep the values bound at compile (planParameters) sealed under this id, for the holder
     * of the plan (an Ask turn, a saved view) to replay it with runCompiledPlan. Record values:
     * sealed under the organisation's data key, never in the plan.
     */
    bindingId: z.uuid().optional(),
    /** Run it (answer) or stop once it is bounded and charged (plan). */
    execute: z.boolean().default(true),
    /** The question may ask for a change (Ask, spec 42.9): compiled to an intent, never executed. */
    intents: z.boolean().default(false),
    purposeSessionIds: purposeSessionIds.optional(),
    /**
     * Asked of an AI agent (D236): its brief goes to the model as documentation, and the model is
     * offered only its object types of those the reader may see (all of them when it names none).
     * It narrows; it never widens what the reader may see. A change or a Cron its tools do not
     * allow is refused before anything is charged. The caller has checked the reader may ask it.
     */
    aiAgent: z.strictObject({
      id: z.uuid(),
      name: z.string().trim().min(1).max(200),
      brief: z.string().max(8_000),
      objectTypeIds: z.array(z.uuid()).max(50),
      tools: z.array(z.enum(['answer', 'find_objects', 'propose_action', 'propose_cron'])).min(1).max(4),
    }).optional(),
  }),
  response: compileOutcome,
  maxBodyBytes: 64 * 1024,
});

/**
 * A plan already in structure (spec 26.2): checked against the reader's vocabulary, kept,
 * bounded and run. No model call, so never metered.
 */
export const compilePlan = defineContract({
  service: 'compile', name: 'compilePlan', method: 'POST', path: '/v1/plans',
  callers: CALLERS,
  // Identical plans are one row (the manifest hash); a retry finds it.
  // Compiled, then run within the executor's bound.
  timeoutMs: RUN_TIMEOUT_MS + 60_000,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    plan: queryPlan,
    parameters: planParameters.default({}),
    trigger: z.enum(['structured', 'saved_view_run', 'dashboard_refresh', 'alert_poll', 'cron_run']).default('structured'),
    execute: z.boolean().default(true),
    purposeSessionIds: purposeSessionIds.optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('answer'), planId: z.uuid(), result: queryResult }),
    z.object({ outcome: z.literal('plan'), planId: z.uuid(), explanation: planExplanation }),
    z.object({ outcome: z.literal('refusal'), refusal }),
  ]),
  maxBodyBytes: 256 * 1024,
});

const RUN_TRIGGERS = ['structured', 'saved_view_run', 'dashboard_refresh', 'alert_poll', 'cron_run'] as const;

/**
 * Runs a stored plan with the values bound when it was compiled (a binding), under the
 * caller's own access now. Never metered: the compile was.
 */
export const runCompiledPlan = defineContract({
  service: 'compile', name: 'runCompiledPlan', method: 'POST', path: '/v1/plans/:planId/runs',
  callers: CALLERS,
  // Compiled, then run within the executor's bound.
  timeoutMs: RUN_TIMEOUT_MS + 60_000,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ planId: z.uuid() }),
  body: z.strictObject({
    /** The binding of the plan's values; a plan with no parameters needs none. */
    bindingId: z.uuid().optional(),
    trigger: z.enum(RUN_TRIGGERS).default('saved_view_run'),
    purposeSessionIds: purposeSessionIds.optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('answer'), result: queryResult }),
    z.object({ outcome: z.literal('refusal'), refusal }),
  ]),
});

/** A binding copied to a new holder: a saved view made from an Ask turn keeps the turn's values. */
export const copyPlanBinding = defineContract({
  service: 'compile', name: 'copyPlanBinding', method: 'POST', path: '/v1/plan-bindings/:bindingId/copies',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ bindingId: z.uuid() }),
  body: z.strictObject({ toBindingId: z.uuid() }),
  response: z.object({ bindingId: z.uuid(), planId: z.uuid() }),
});

/** A stored plan's structure, for an Ask thread, a saved view or an analysis step to replay. */
export const getCompiledPlan = defineContract({
  service: 'compile', name: 'getCompiledPlan', method: 'GET', path: '/v1/plans/:planId',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ planId: z.uuid() }),
  response: z.object({
    planId: z.uuid(),
    plan: queryPlan,
    compileClass: z.enum(COMPILE_CLASSES),
    ontologyVersionId: z.uuid(),
    /** The policy version in force at compile: a stale plan is detectable (it is re-checked when run). */
    policyVersion: z.int(),
    createdAt: z.string(),
  }),
});

/** What this reader may plan over (spec 26.3), by id: for Explorer filters and Studio bindings. */
export const getVocabulary = defineContract({
  service: 'compile', name: 'getVocabulary', method: 'GET', path: '/v1/vocabulary',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  /** A branch's head for a holder of ontology.branch on it (spec 25.3); main's head when neither is given. */
  query: z.strictObject({ ontologyVersionId: z.uuid().optional(), branchId: z.uuid().optional() }),
  response: z.object({
    ontologyVersionId: z.uuid(),
    objectTypes: z.array(z.object({
      id: z.uuid(),
      apiName: z.string(),
      displayName: z.string(),
      pluralName: z.string(),
      description: z.string().nullable(),
      /** single_source: one system's records; resolvable: merged across systems by the entity graph. */
      resolutionClass: z.enum(['single_source', 'resolvable']),
      /** The title property, where the reader may see it (spec 34.2's header, 33.5's matches); otherwise the type name stands in. */
      titleProperty: z.uuid().nullable(),
      /** The identifying property, where the reader may see it unmasked: what names one object in a filter (spec 37.8). */
      primaryKey: z.uuid().nullable(),
      /** The interfaces it implements that the reader may see (spec 34.1 groups types by them). */
      interfaces: z.array(z.uuid()),
      properties: z.array(z.object({
        identityId: z.uuid(),
        apiName: z.string(),
        displayName: z.string(),
        dataType: z.enum(DATA_TYPES),
        description: z.string().nullable(),
        /** A masked or redacted property is shown but never filtered, sorted or grouped on. */
        effect: z.enum(['allow', 'mask', 'redact']),
        isTimeField: z.boolean(),
      })),
      defaultTimeField: z.uuid().nullable(),
    })),
    linkTypes: z.array(z.object({
      id: z.uuid(),
      apiName: z.string(),
      /** As read from the from side, and from the to side (spec 34.2: linked objects by link type and direction). */
      forwardName: z.string(),
      reverseName: z.string(),
      fromTypeId: z.uuid(),
      toTypeId: z.uuid(),
      /** Only the routes through connections this reader holds (spec 26.3). */
      routes: z.array(z.object({ id: z.uuid(), position: z.int() })),
      defaultRouteId: z.uuid().nullable(),
    })),
    /** The interfaces the reader may see that a visible type implements. */
    interfaces: z.array(z.object({ id: z.uuid(), apiName: z.string(), displayName: z.string(), description: z.string().nullable() })),
  }),
});
