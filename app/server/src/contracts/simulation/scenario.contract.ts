// Failure scenarios and their runs (spec 39.4, 39.6, 39.7, 39.9).
//
// A failure scenario states a failure on named objects: unavailable, or delayed by a
// duration. The deterministic engine walks the confirmed graph from them and returns every
// downstream object reached, with the path of edges from the cause and the accumulated
// delay. It never states that one thing caused another: the failure reaches these objects
// through these confirmed edges.
//
// - A hard edge propagates the failure; a soft edge propagates its delay and the object
//   continues. Paths through any soft edge are reported apart from hard-only paths.
// - An unconfirmed edge stops the walk there, and says so (simulation_crossed_unconfirmed_edge).
// - An object type the runner is not cleared for stops the walk at that edge.
// - Fan-out beyond the per-hop bound stops and names the hop; nothing is truncated.
// - Results persist as references, paths and delays, never record values.
//
// Every run is charged against the simulation allowance (spec 73): the first run of a
// scenario as a simulation, a re-run at the reduced re-run rate, under the request's key so
// a retry is never charged twice. Re-running uses current data and the current graph.

import { z } from 'zod';
import { shareGrantee, viewShareView } from '../workspace/sharing.contract.ts';
import { VIEW_ACCESS } from '../workspace/view.contract.ts';
import { defineContract, MAX_TIMEOUT_MS } from '../endpoint.contract.ts';
import { duration } from './graph.contract.ts';

export const FAILURE_FORMS = ['unavailable', 'delayed', 'unavailable_for_period', 'reduced_capacity'] as const;

export const statedFailure = z.strictObject({
  form: z.enum(FAILURE_FORMS),
  /** delayed only. */
  delay: duration.optional(),
  /** unavailable_for_period only: how long the objects are out (decision 2026-11-14). */
  period: duration.optional(),
  /** reduced_capacity only: the share of each resource's capacity left, above 0 and below 1 (decision 2026-11-14). */
  capacityRemaining: z.number().gt(0).lt(1).optional(),
  objectTypeId: z.uuid(),
  /** Silo object ids of the objects that fail. */
  objectIds: z.array(z.uuid()).min(1).max(100),
}).refine((f) => (f.form === 'delayed') === (f.delay !== undefined), 'a delayed failure states its delay, and only it')
  .refine((f) => (f.form === 'unavailable_for_period') === (f.period !== undefined), 'unavailable for a period states its period, and only it')
  .refine((f) => (f.form === 'reduced_capacity') === (f.capacityRemaining !== undefined), 'reduced capacity states the share left, and only it');
export type StatedFailure = z.infer<typeof statedFailure>;

export const bounds = z.strictObject({
  hops: z.int().min(1).max(8).default(4),
  /** Objects newly reached at any one hop. */
  fanOut: z.int().min(1).max(10_000).default(1_000),
  /** Probabilistic runs (39.5): Monte Carlo iterations, bounded and stated; 1,000 when absent. */
  iterations: z.int().min(100).max(10_000).optional(),
});

export const scenarioView = z.object({
  id: z.uuid(),
  name: z.string(),
  /** How the reader holds it: its owner, or through a share (view, run or copy) the owner's sharing policy still permits. */
  access: z.enum(['owner', 'view', 'run', 'copy']),
  kind: z.enum(['failure', 'branch']),
  statedFailure: statedFailure.nullable(),
  mode: z.enum(['deterministic', 'probabilistic']),
  bounds: z.object({ hops: z.int(), fanOut: z.int(), iterations: z.int().optional() }),
  graphVersion: z.int(),
  version: z.int(),
  createdAt: z.string(),
});
export type ScenarioView = z.infer<typeof scenarioView>;

export const resultView = z.object({
  kind: z.enum(['reached', 'stopped']),
  objectTypeId: z.uuid().nullable(),
  objectId: z.uuid().nullable(),
  /** The path passes through a soft edge: reported apart from hard-only paths. */
  viaSoftEdge: z.boolean(),
  /** ISO 8601 duration of the accumulated delay; null where the object fails outright. */
  delay: z.string().nullable(),
  /** Hard: the failure reaches it; soft: it continues delayed; constrained: its resource cannot meet its demand (D86). */
  effect: z.enum(['fails', 'delayed', 'constrained']).nullable(),
  /** constrained only: the share of its resource's demand that cannot be met in the period, and the period. */
  shortfall: z.number().nullable(),
  period: z.enum(['day', 'week', 'month']).nullable(),
  /**
   * Unavailable for a period (decision 2026-11-14): ISO 8601 duration it is out for, the longer
   * of the outage reaching it and its recovery lead time (observed where history holds it,
   * otherwise the edge's stated lead time); null otherwise.
   */
  unavailableFor: z.string().nullable(),
  /**
   * probabilistic: every edge on the path has observations; deterministic: computed from stated lead times, and said so (39.5);
   * inferred: the organisation turned inference on, and the path was simulated from beliefs combining stated lead times with any
   * observations (D72).
   */
  pathMode: z.enum(['deterministic', 'probabilistic', 'inferred']),
  /** probabilistic only: the share of iterations that affect the object; delay is then the median. */
  probability: z.number().nullable(),
  /** probabilistic only: the 95% credible interval of that share, from the iteration count (a uniform prior). */
  probabilityInterval: z.tuple([z.number(), z.number()]).nullable(),
  spread: z.object({ p10: z.string().nullable(), p50: z.string().nullable(), p90: z.string().nullable() }).nullable(),
  path: z.array(z.object({ edgeId: z.uuid(), kind: z.enum(['hard', 'soft', 'resource']), source: z.enum(['structure', 'history', 'stated']),
    sampleSize: z.int().nullable() })),
  stop: z.object({
    reason: z.enum(['unconfirmed_edge', 'bounded_hop', 'uncleared_object_type']),
    edgeId: z.uuid().nullable(),
    objectTypeId: z.uuid().nullable(),
    hop: z.int().nullable(),
  }).nullable(),
});
export type ResultView = z.infer<typeof resultView>;

export const runView = z.object({
  runId: z.uuid(),
  scenarioId: z.uuid(),
  mode: z.enum(['deterministic', 'probabilistic']),
  graphVersion: z.int(),
  status: z.enum(['running', 'completed', 'failed']),
  boundedAtHop: z.int().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  /** The charge: a first run is a simulation, a re-run the reduced re-run rate. */
  charge: z.object({ operation: z.enum(['simulation', 'simulation_rerun']), weight: z.string() }).nullable(),
  reached: z.array(resultView),
  stopped: z.array(resultView),
  /** Results left out because the reader cannot see their object type. Counted, never described. */
  withheld: z.int(),
  /** probabilistic: the iterations run, and the limitation every probabilistic output states. */
  iterations: z.int().nullable(),
  statement: z.string().nullable(),
  /** Whether the run went beyond observed history (the organisation's inference switch, D72), and what it assumed. */
  inferred: z.boolean(),
  inferenceStatement: z.string().nullable(),
});
export type RunView = z.infer<typeof runView>;

// ask: start a scenario (36.4).
const CALLERS = ['gateway', 'fde-orchestrator', 'recognition', 'ask'] as const;

/** simulation.run: save a failure scenario (private by default). */
export const saveScenario = defineContract({
  service: 'simulation', name: 'saveScenario', method: 'POST', path: '/v1/simulation/scenarios', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    statedFailure,
    mode: z.enum(['deterministic', 'probabilistic']).default('deterministic'),
    bounds: bounds.default({ hops: 4, fanOut: 1_000 }),
  }),
  response: scenarioView,
  status: 201,
  maxBodyBytes: 16_384,
});

export const listScenarios = defineContract({
  service: 'simulation', name: 'listScenarios', method: 'GET', path: '/v1/simulation/scenarios', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  /** mine: the reader's own; shared: those shared with them and live now (39.7). */
  query: z.strictObject({ filter: z.enum(['mine', 'shared']).default('mine') }),
  response: z.object({ scenarios: z.array(scenarioView) }),
});

/**
 * The object view's scenarios section (spec 34.2, 39): the scenarios the reader holds (their
 * own, or shared and live) whose branch stages an Action targeting the object, or
 * whose latest completed run (of the scenario or of a branch) reaches the object.
 */
export const listObjectScenarios = defineContract({
  service: 'simulation', name: 'listObjectScenarios', method: 'POST', path: '/v1/simulation/object-scenarios', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeId: z.uuid(), objectId: z.uuid() }),
  response: z.object({
    scenarios: z.array(z.object({
      scenario: scenarioView,
      staged: z.array(z.object({
        branchId: z.uuid(), branchName: z.string(), branchStatus: z.enum(['open', 'promoted', 'partially_promoted', 'closed']),
        stagedActionId: z.uuid(), actionTypeId: z.uuid(), staleness: z.enum(['clean', 'conflicted', 'already_applied', 'orphaned']),
      })),
      reached: z.array(z.object({
        runId: z.uuid(), branchId: z.uuid().nullable(), completedAt: z.string(),
        effect: z.enum(['fails', 'delayed', 'constrained']),
        /** ISO 8601 durations, as a run states them. */
        delay: z.string().nullable(), unavailableFor: z.string().nullable(),
        probability: z.number().nullable(),
      })),
    })),
  }),
  maxBodyBytes: 16 * 1024,
});

const shareParams = z.strictObject({ scenarioId: z.uuid() });

/** Shared as saved views are (39.7): with a member, a scope or the organisation, within the sharing policy. Its owner only. */
export const shareScenario = defineContract({
  service: 'simulation', name: 'shareScenario', method: 'PUT', path: '/v1/simulation/scenarios/:scenarioId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: shareParams,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(VIEW_ACCESS), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: viewShareView,
});

export const revokeScenarioShare = defineContract({
  service: 'simulation', name: 'revokeScenarioShare', method: 'POST', path: '/v1/simulation/scenarios/:scenarioId/shares/:shareId/revoke',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scenarioId: z.uuid(), shareId: z.uuid() }),
  response: viewShareView,
});

export const listScenarioShares = defineContract({
  service: 'simulation', name: 'listScenarioShares', method: 'GET', path: '/v1/simulation/scenarios/:scenarioId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: shareParams,
  response: z.object({ shares: z.array(viewShareView) }),
});

/** A share with copy access lets its holder save the scenario as their own, private again. */
export const copyScenario = defineContract({
  service: 'simulation', name: 'copyScenario', method: 'POST', path: '/v1/simulation/scenarios/:scenarioId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: shareParams,
  body: z.strictObject({ name: z.string().trim().min(1).max(200) }),
  response: scenarioView,
  status: 201,
});

export const getScenario = defineContract({
  // canvas-layout: a view's overlay is shown only to an opener who may see its scenario (30.9).
  service: 'simulation', name: 'getScenario', method: 'GET', path: '/v1/simulation/scenarios/:scenarioId', callers: [...CALLERS, 'canvas-layout'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scenarioId: z.uuid() }),
  response: scenarioView,
});

/** simulation.run: run (or re-run) a scenario on current data and the current graph. Keyed: a retry is charged once. */
export const runScenario = defineContract({
  service: 'simulation', name: 'runScenario', method: 'POST', path: '/v1/simulation/scenarios/:scenarioId/runs', callers: ['gateway', 'fde-orchestrator'],
  // A walk reads each hop through the executor: the longest wait a contract may declare.
  timeoutMs: MAX_TIMEOUT_MS,
  shed: 'simulation', context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ scenarioId: z.uuid() }),
  response: runView,
  status: 201,
});

export const getSimulationRun = defineContract({
  service: 'simulation', name: 'getSimulationRun', method: 'GET', path: '/v1/simulation/runs/:runId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runId: z.uuid() }),
  response: runView,
});

/**
 * A scenario's latest completed run as stored, for the canvas's overlay (30.9), which draws it
 * without running it again: with the confirmed graph's version now, and whether it has changed
 * since the run, so the overlay can say so and offer a re-run (metered as a simulation).
 */
export const getLatestSimulationRun = defineContract({
  service: 'simulation', name: 'getLatestSimulationRun', method: 'GET', path: '/v1/simulation/scenarios/:scenarioId/runs/latest', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scenarioId: z.uuid() }),
  response: z.object({ run: runView.nullable(), graphVersion: z.int(), graphChanged: z.boolean() }),
});

/**
 * A scenario's own runs (not its branches'), newest first, without their results: what a person
 * chooses two of to compare, on any visit (D269). Whoever holds the scenario reads them.
 */
export const listSimulationRuns = defineContract({
  service: 'simulation', name: 'listSimulationRuns', method: 'GET', path: '/v1/simulation/scenarios/:scenarioId/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scenarioId: z.uuid() }),
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({
    runs: z.array(z.object({
      runId: z.uuid(), mode: z.enum(['deterministic', 'probabilistic']), iterations: z.int().nullable(), graphVersion: z.int(),
      status: z.enum(['running', 'completed', 'failed']), boundedAtHop: z.int().nullable(), inferred: z.boolean(),
      runBy: z.uuid(), startedAt: z.string(), completedAt: z.string().nullable(),
    })),
  }),
});

/** Which objects entered or left the affected set between two runs of one scenario, and whether the graph changed (39.7). */
export const compareRuns = defineContract({
  service: 'simulation', name: 'compareRuns', method: 'GET', path: '/v1/simulation/scenarios/:scenarioId/comparisons', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scenarioId: z.uuid() }),
  query: z.strictObject({ from: z.uuid(), to: z.uuid() }),
  response: z.object({
    entered: z.array(z.object({ objectTypeId: z.uuid(), objectId: z.uuid() })),
    left: z.array(z.object({ objectTypeId: z.uuid(), objectId: z.uuid() })),
    /** The graph versions differ: an edge on a path may have been confirmed differently since. */
    graphChanged: z.boolean(),
    /** When the graph changed, the runs are not comparable as like for like, and the product says so. */
    comparable: z.boolean(),
  }),
});
