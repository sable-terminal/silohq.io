// conformance: the fixed suite run against every connector on every route (spec 17.1, 17.2;
// design: connect.conformance_runs).
//
// A run executes the read, pagination, filter pushdown and error classes against one
// connection through connect-runtime, and records each test's outcome: passed, failed, or
// not applicable (never counted as passed). Results hold test ids, outcomes, durations and
// redacted reasons (codes and counts), never a record value.
//
// The gate (spec 17.2): a connection becomes verified only on a completed run, on its
// current manifest version, that ran the read, pagination and error classes with no failed
// test among them and at least one passed read test. A failing filter, sort or aggregate
// is removed from what the runtime pushes down for that version, so it is computed after
// instead (the binding rule: a source that ignores a filter must not look like an answer).
// The write-verify-undo class earns writes (writeClass.contract.ts); the change-stream class
// makes a stream subscribable (changeStreamClass.contract.ts). Neither counts here.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** The suite version, recorded with every run. A change to a test changes it. */
export const SUITE_VERSION = '2026.11.1';

export const CONFORMANCE_CLASSES = ['read', 'pagination', 'filter_pushdown', 'error', 'write_verify_undo', 'change_stream'] as const;
export type ConformanceClass = (typeof CONFORMANCE_CLASSES)[number];
/** The classes this release runs. */
export const RUNNABLE_CLASSES = ['read', 'pagination', 'filter_pushdown', 'error'] as const;
export type RunnableClass = (typeof RUNNABLE_CLASSES)[number];
/** Required for verified status (spec 17.2). */
export const VERIFIED_CLASSES: readonly ConformanceClass[] = ['read', 'pagination', 'error'];

export const conformanceTest = z.object({
  /** class.test[.object[.field[.op]]], as stable across runs as the manifest is. */
  id: z.string().max(300),
  class: z.enum(CONFORMANCE_CLASSES),
  object: z.string().max(63).nullable(),
  outcome: z.enum(['passed', 'failed', 'not_applicable']),
  durationMs: z.number().int().min(0),
  /** Codes and counts only. */
  reason: z.string().max(200).nullable(),
  /** Filter pushdown tests: the declared field and operator (sort, or an aggregate function). */
  operator: z.object({ field: z.string().max(63), op: z.string().max(40) }).nullable(),
});
export type ConformanceTest = z.infer<typeof conformanceTest>;
export const conformanceResults = z.array(conformanceTest).max(10_000);

export interface FailingOperator { object: string; field: string; op: string }

export interface Gate {
  verified: boolean;
  /** Required classes not run, or with a failed test. */
  failedClasses: ConformanceClass[];
  /** Pushdown that failed: computed after the source for this version. */
  failingOperators: FailingOperator[];
}

/** The gate over one run's record. A run still in progress, or abandoned, verifies nothing. */
export function gateOf(run: { classesRun: readonly string[]; results: unknown; completedAt: string | null }): Gate {
  const parsed = conformanceResults.safeParse(run.results);
  const tests = parsed.success ? parsed.data : [];
  const failingOperators = tests
    .filter((t) => t.class === 'filter_pushdown' && t.outcome === 'failed' && t.operator !== null && t.object !== null)
    .map((t) => ({ object: t.object!, field: t.operator!.field, op: t.operator!.op }));
  const failedClasses = VERIFIED_CLASSES.filter((c) => !run.classesRun.includes(c) || tests.some((t) => t.class === c && t.outcome === 'failed'));
  const abandoned = tests.some((t) => t.id === 'suite.completed' && t.outcome === 'failed');
  const verified = parsed.success && run.completedAt !== null && !abandoned && failedClasses.length === 0
    && tests.some((t) => t.class === 'read' && t.outcome === 'passed');
  return { verified, failedClasses, failingOperators };
}

export const conformanceRunView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  manifestId: z.uuid(),
  suiteVersion: z.string(),
  trigger: z.enum(['build', 'release', 'weekly', 'self_heal', 'manual']),
  route: z.enum(['catalogue', 'ai', 'visual']),
  classesRun: z.array(z.enum(CONFORMANCE_CLASSES)),
  status: z.enum(['running', 'completed', 'abandoned']),
  passedCount: z.number().int(),
  failedCount: z.number().int(),
  notApplicableCount: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  tests: conformanceResults,
  gate: z.object({
    verified: z.boolean(),
    failedClasses: z.array(z.enum(CONFORMANCE_CLASSES)),
    failingOperators: z.array(z.object({ object: z.string(), field: z.string(), op: z.string() })),
  }),
});
export type ConformanceRunView = z.infer<typeof conformanceRunView>;
const runView = conformanceRunView;

const CALLERS = ['gateway', 'connector-builder', 'visual-builder', 'connector-maintenance'] as const;

export const startConformanceRun = defineContract({
  service: 'conformance', name: 'startConformanceRun', method: 'POST', path: '/v1/conformance-runs', callers: CALLERS,
  // A run reads the source many times and is recorded; a retried request returns the first.
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    connectionId: z.uuid(),
    classes: z.array(z.enum(RUNNABLE_CLASSES)).min(1).max(RUNNABLE_CLASSES.length)
      .refine((c) => new Set(c).size === c.length, 'each class once').default([...RUNNABLE_CLASSES]),
    trigger: z.enum(['build', 'weekly', 'self_heal', 'manual']).default('manual'),
    /**
     * connector-maintenance only, with trigger self_heal: test this version of the
     * connection's connector, a repair not yet applied (spec 17.3: propose, sandbox test,
     * apply). The run is recorded against that version.
     */
    manifestId: z.uuid().optional(),
  }),
  response: runView,
  // The run continues after the reply; read it back to see it complete.
  status: 202,
  maxBodyBytes: 4_096,
});

export const getConformanceRun = defineContract({
  service: 'conformance', name: 'getConformanceRun', method: 'GET', path: '/v1/conformance-runs/:runId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runId: z.uuid() }),
  response: runView,
});

export const listConformanceRuns = defineContract({
  service: 'conformance', name: 'listConformanceRuns', method: 'GET', path: '/v1/connections/:connectionId/conformance-runs',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  response: z.object({ runs: z.array(runView.omit({ tests: true })) }),
});
