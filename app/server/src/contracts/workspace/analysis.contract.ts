// Analysis over object sets in the workspace (spec 37.8): a person builds a chain of typed steps by
// hand (from Explorer, an object view's link group, an Ask answer or a Studio chart), runs it step by
// step, and saves it as a view of kind analysis. compile keeps the chain as an analysis manifest and
// its values in a binding (the analysis's own id); the workspace records the steps, which are
// immutable (a changed chain is a new manifest). Building by hand uses no model and is never metered.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { analysisStep, keptStep, MAX_STEPS, stepOutcome } from '../compile/analysis.contract.ts';
import { planParameters, refusal } from '../planner/plan.contract.ts';
import { chartAsViewed } from '../studio/app.contract.ts';

const CALLERS = ['gateway'] as const;
const manifestParams = z.strictObject({ manifestId: z.uuid() });

export const createAnalysis = defineContract({
  service: 'workspace', name: 'createAnalysis', method: 'POST', path: '/v1/workspace/analyses', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    steps: z.array(analysisStep).min(1).max(MAX_STEPS),
    /** The values the steps' placeholders stand for. Record values: sealed, never kept with the chain. */
    parameters: planParameters.default({}),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('analysis'),
      /** The analysis's own id: its values are kept under it, and a view saved from it copies them. */
      analysisId: z.uuid(),
      manifestId: z.uuid(),
      steps: z.array(keptStep.omit({ plans: true })),
    }),
    /** The step the chain could not be planned at, and why. */
    z.object({ outcome: z.literal('refusal'), refused: z.object({ position: z.int(), operation: z.string(), refusal }) }),
  ]),
  maxBodyBytes: 256 * 1024,
});

/** An analysis started from something else: made, refused at a step, or not a chain at all (and why). */
const startedOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('analysis'), analysisId: z.uuid(), manifestId: z.uuid(), steps: z.array(keptStep.omit({ plans: true })),
    /** What the steps do not keep of where they came from, said plainly. */
    notes: z.array(z.string()),
  }),
  z.object({ outcome: z.literal('refusal'), refused: z.object({ position: z.int(), operation: z.string(), refusal }) }),
  /** Its shape is not a chain, and why. */
  z.object({ outcome: z.literal('not_steps'), refusal }),
]);

/** An Ask answer continued as an analysis (37.8): the asker's own turn, its plan made steps, its values copied under the analysis. */
export const createAnalysisFromTurn = defineContract({
  service: 'workspace', name: 'createAnalysisFromTurn', method: 'POST', path: '/v1/workspace/analyses/from-turn', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ threadId: z.uuid(), sequence: z.int().min(1) }),
  response: startedOutcome,
});

/**
 * A Studio chart continued as an analysis (37.8): the chart of an app the viewer may run, made steps
 * by Studio for their values and filter controls, compiled and kept as a chain under the analysis's
 * own id. Built from typed operations with no model, so never metered.
 */
export const createAnalysisFromAppChart = defineContract({
  service: 'workspace', name: 'createAnalysisFromAppChart', method: 'POST', path: '/v1/workspace/analyses/from-app-chart', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: chartAsViewed.extend({ appId: z.uuid(), widgetId: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }),
  response: startedOutcome,
  maxBodyBytes: 32_768,
});

export const readAnalysis = defineContract({
  service: 'workspace', name: 'readAnalysis', method: 'GET', path: '/v1/workspace/analyses/:manifestId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: manifestParams,
  query: z.strictObject({ analysisId: z.uuid().optional() }),
  response: z.object({
    manifestId: z.uuid(), createdAt: z.string(), steps: z.array(keptStep.omit({ plans: true })),
    /** The values, only for the person who bound them under this analysis. */
    parameters: planParameters.nullable(),
  }),
});

export const runAnalysis = defineContract({
  service: 'workspace', name: 'runAnalysis', method: 'POST', path: '/v1/workspace/analyses/:manifestId/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: manifestParams,
  body: z.strictObject({ analysisId: z.uuid().optional(), upTo: z.int().min(1).max(MAX_STEPS).optional() }),
  response: z.object({ manifestId: z.uuid(), steps: z.array(stepOutcome) }),
});
