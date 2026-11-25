// Analysis over object sets (spec 37.8): an ordered chain of typed steps, each producing an object
// set or a result. Built by hand from typed operations, with no model and no metering; compiled here
// into one plan per step (two for a comparison, each side run separately), each checked against
// the reader's vocabulary and bounds, and kept as an analysis manifest with its values sealed in a
// binding, as a plan's are (spec 26). Run step by step: every step is bounded, a step whose output
// exceeds its bound is refused naming the step, the bound and the count, the steps before it keep
// their results, and nothing runs past a refused step on a partial input.
//
// Steps and their inputs:
// - filter: a fresh set of one type (base), or more filters on an earlier set (input).
// - traverse: the objects of a link's other type reaching an earlier set (required, so an object
//   linked to none of it is not a member), with filters of its own.
// - derive: an earlier set with properties computed by the engine (functions over bounded members).
// - select: the objects behind one group of an earlier group, time series or pivot step: its input
//   set narrowed to the group's key (a time bucket by its period's start and the next).
// - group, time_series, pivot: an earlier set aggregated; pivot is two keys, reshaped by the reader.
// - compare: one aggregate over two earlier sets, each run separately; shown side by side, never averaged.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { CALENDAR_UNITS, MEASURE_FUNCTIONS, paramRef, planFilter, planParameters, planPeriod, queryPlan, refusal } from '../planner/plan.contract.ts';

export const ANALYSIS_OPERATIONS = ['filter', 'traverse', 'group', 'pivot', 'compare', 'time_series', 'derive', 'select'] as const;
export type AnalysisOperation = (typeof ANALYSIS_OPERATIONS)[number];
export const SET_OPERATIONS: readonly AnalysisOperation[] = ['filter', 'traverse', 'derive', 'select'];
export const ANALYSIS_SCHEMA_VERSION = 'analysis-1';
/** Most steps in one chain. */
export const MAX_STEPS = 20;
/** The default bounds: members of a set, groups of a result. */
export const SET_BOUND = 10_000;
export const RESULT_BOUND = 1_000;

const position = z.int().min(1).max(MAX_STEPS);
const alias = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower snake case');
const filters = z.array(planFilter).max(20).default([]);
/** Properties shown with each member besides its title. */
const show = z.array(z.uuid()).max(20).default([]);
const setBound = z.int().min(1).max(100_000).default(SET_BOUND);
const resultBound = z.int().min(1).max(10_000).default(RESULT_BOUND);
export const analysisMeasure = z.strictObject({
  fn: z.enum(MEASURE_FUNCTIONS),
  /** Absent only for count, which counts members. */
  property: z.uuid().optional(),
  as: alias,
});
const groupKey = z.strictObject({ property: z.uuid(), bucket: z.enum(CALENDAR_UNITS).optional() });

export const analysisStep = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('filter'),
    /** An earlier set to narrow, or a fresh set of a type: exactly one. */
    input: position.optional(), base: z.strictObject({ objectTypeId: z.uuid() }).optional(),
    /** A period on a time field, as the asker wrote it: resolved again on every run, never fixed (26.8). */
    filters, period: planPeriod.optional(), show, bound: setBound,
  }),
  z.strictObject({ operation: z.literal('traverse'), input: position, linkTypeId: z.uuid(), routeId: z.uuid().optional(), filters, period: planPeriod.optional(), show, bound: setBound }),
  z.strictObject({ operation: z.literal('derive'), input: position, properties: z.array(z.uuid()).min(1).max(10), bound: setBound }),
  z.strictObject({
    operation: z.literal('select'), input: position,
    /** The group's key: each property's value (null for the group of none), or a bucket's start and the next period's. */
    key: z.array(z.strictObject({ property: z.uuid(), value: paramRef.nullable(), to: paramRef.optional() })).min(1).max(5),
    show, bound: setBound,
  }),
  z.strictObject({ operation: z.literal('group'), input: position, groupBy: z.array(groupKey).max(5).default([]), measures: z.array(analysisMeasure).min(1).max(20), bound: resultBound }),
  z.strictObject({ operation: z.literal('time_series'), input: position, property: z.uuid(), unit: z.enum(CALENDAR_UNITS), measures: z.array(analysisMeasure).min(1).max(20), bound: resultBound }),
  z.strictObject({ operation: z.literal('pivot'), input: position, rows: z.uuid(), columns: z.uuid(), measure: analysisMeasure, bound: resultBound }),
  z.strictObject({ operation: z.literal('compare'), inputs: z.tuple([position, position]), groupBy: z.array(groupKey).max(2).default([]), measures: z.array(analysisMeasure).min(1).max(20), bound: resultBound }),
]);
export type AnalysisStep = z.output<typeof analysisStep>;
export type AnalysisStepInput = z.input<typeof analysisStep>;

/** A kept step: its position, what it makes, its bound, its plans (two for a comparison) and the earlier steps it reads. */
export const keptStep = z.object({
  position,
  operation: z.enum(ANALYSIS_OPERATIONS),
  inputSteps: z.array(position),
  outputKind: z.enum(['object_set', 'result']),
  bound: z.int(),
  step: analysisStep,
  plans: z.array(queryPlan).min(1).max(2),
});
export type KeptStep = z.infer<typeof keptStep>;

/** A refusal naming the step it stopped at (37.8). */
const stepRefusal = z.object({ position, operation: z.enum(ANALYSIS_OPERATIONS), refusal });

export const compileAnalysis = defineContract({
  service: 'compile', name: 'compileAnalysis', method: 'POST', path: '/v1/analyses', callers: ['workspace'],
  // Identical chains are one manifest (its hash); the values are kept under the caller's binding.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    steps: z.array(analysisStep).min(1).max(MAX_STEPS),
    /** The values the steps' placeholders stand for. Record values: sealed, never kept with the chain. */
    parameters: planParameters.default({}),
    bindingId: z.uuid(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('analysis'), manifestId: z.uuid(), ontologyVersionId: z.uuid(), steps: z.array(keptStep) }),
    z.object({ outcome: z.literal('refusal'), refused: stepRefusal }),
  ]),
  maxBodyBytes: 256 * 1024,
});

/**
 * An answer continued as an analysis (spec 37.8): a stored plan, with the values bound to it, made
 * into steps (the deepest filtered type first, then each link back to the answer's own objects, then
 * its aggregate) and kept as a chain. A plan whose shape is not a chain (branches, an as-of or a
 * history question, a linked node only shown, a measure over linked objects) is said not to be one.
 */
export const analysisFromPlan = defineContract({
  service: 'compile', name: 'analysisFromPlan', method: 'POST', path: '/v1/analyses/from-plan', callers: ['workspace'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ planId: z.uuid(), fromBindingId: z.uuid().optional(), bindingId: z.uuid() }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('analysis'), manifestId: z.uuid(), ontologyVersionId: z.uuid(), steps: z.array(keptStep),
      /** What the steps do not keep of the answer, said plainly (its limit, its order). */
      notes: z.array(z.string()),
    }),
    z.object({ outcome: z.literal('refusal'), refused: stepRefusal }),
    z.object({ outcome: z.literal('not_steps'), refusal }),
  ]),
});

/** A step's outcome when run: its results (two for a comparison), its refusal, or not run after a refused step. */
export const stepOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('result'), position, operation: z.enum(ANALYSIS_OPERATIONS), outputKind: z.enum(['object_set', 'result']),
    /** Results by reference, read again with readResult while they live. */
    results: z.array(z.object({
      queryId: z.uuid(), kind: z.enum(['objects', 'groups']), total: z.int(), population: z.int(), computedAt: z.string(),
      /** Part of it was not visible to the reader and was dropped (37.5). */
      reduced: z.boolean(),
    })).min(1).max(2),
  }),
  z.object({ outcome: z.literal('refused'), position, operation: z.enum(ANALYSIS_OPERATIONS), refusal }),
  z.object({ outcome: z.literal('not_run'), position, operation: z.enum(ANALYSIS_OPERATIONS) }),
]);
export type StepOutcome = z.infer<typeof stepOutcome>;

export const runAnalysis = defineContract({
  service: 'compile', name: 'runAnalysis', method: 'POST', path: '/v1/analyses/:manifestId/runs', callers: ['workspace'],
  // A run changes nothing; each step is answered or refused within the executor's bound.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ manifestId: z.uuid() }),
  body: z.strictObject({
    bindingId: z.uuid().optional(),
    /** Run only this far: a builder looking at one step. */
    upTo: position.optional(),
    trigger: z.enum(['structured', 'saved_view_run', 'dashboard_refresh', 'alert_poll', 'cron_run']).default('structured'),
    purposeSessionIds: z.array(z.uuid()).max(16).optional(),
  }),
  response: z.object({ manifestId: z.uuid(), steps: z.array(stepOutcome) }),
});

/** An analysis manifest's steps, and the values its binding holds for the binding's own maker. */
export const getAnalysis = defineContract({
  service: 'compile', name: 'getAnalysis', method: 'GET', path: '/v1/analyses/:manifestId', callers: ['workspace'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ manifestId: z.uuid() }),
  query: z.strictObject({ bindingId: z.uuid().optional() }),
  response: z.object({
    manifestId: z.uuid(), ontologyVersionId: z.uuid(), createdAt: z.string(), steps: z.array(keptStep),
    /** The values, only for the person who bound them. */
    parameters: planParameters.nullable(),
  }),
});
