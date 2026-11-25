// Limits. Most are fixed by the spec and are constants here, each with its section; a
// change to one is a spec change. The executor's bounds are "per-cell configuration
// visible to the customer" (spec 7.10) and are read from the environment.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  // Spec 8.1: redis-data lifetimes, in seconds.
  redisData: {
    resultPageTtl: 15 * MINUTE,
    resultCacheTtl: 5 * MINUTE,
    captureQueueTtl: 10 * MINUTE,
    idempotencyKeyTtl: DAY,
  },
  // Spec 7.9, 8.1: redis-state and the state plane.
  statePlane: {
    idleTtl: 15 * MINUTE,
    absoluteTtl: DAY,
    liveObjectsPerOrganisation: 1_000_000,
    coalesceMs: 250,
    clientBufferDeltas: 1_000,
    clientBufferBytes: 4 * 1024 * 1024,
    snapshotModeIntervalMs: 2_000,
    revocationCloseSeconds: 30,
  },
  // Spec 9.1, 9.4, 9.5: the buses.
  bus: {
    liveMessageBytes: 256 * 1024,
    durableMessageBytes: 64 * 1024,
    durableRetentionSeconds: 7 * DAY,
    auditBacklogPageSeconds: 5 * MINUTE,
    changeEventsPerSecondPerOrganisation: 5_000,
    changeEventsPerSecondPerConnection: 1_000,
    subscriptionsPerSession: 50,
    objectsPerSubscription: 100_000,
    deltasPerSecondPerClient: 500,
  },
  // Spec 61.4: unwrapped data keys.
  dekCache: { maxAgeMs: 5 * MINUTE * 1000, maxUses: 200 },
  // Spec 10.2, 10.3, 10.6, 10.7: the Silo Agent.
  agent: {
    enrolmentTokenTtl: DAY,
    heartbeatSeconds: 10,
    heartbeatMissesUnhealthy: 3,
    certificateValidDays: 30,
    certificateRenewAtDays: 20,
    spoolBytes: 10 * 1024 * 1024 * 1024,
    spoolSeconds: 7 * DAY,
    spoolSecondsAirGapped: 30 * DAY,
    concurrentCalls: 32,
    cdcReaders: 16,
    poolFailoverSeconds: 30,
  },
  // Spec 13.3, 63.6: operator break-glass sessions.
  operatorAccessMaxSeconds: 4 * HOUR,
  // Spec 6.3: cell placement.
  cell: { organisations: 2_000, connections: 50_000, provisionAtRatio: 0.75, rebalanceAtRatio: 1.1 },
  // Spec 5.6, 44: Action approval thresholds.
  actions: { additionalApprovalRows: 100, canaryRows: 10_000 },
} as const;

const schema = z.object({
  // Rows one source step may return (decision 2026-10-29). A separate bound from
  // maxResultRows, the merged result a person receives.
  maxRowsPerSourceStep: zPositiveInt().default(100_000),
  maxResultRows: zPositiveInt().default(50_000),
  localStepBytes: zPositiveInt().default(256 * 1024 * 1024),
  // At most two minutes: callers wait the run contracts' timeout, this and a margin (contracts/executor/result.contract.ts).
  wallTimeMs: zPositiveInt(120_000).default(60_000),
  fanOutPerHop: zPositiveInt().default(1_000),
  concurrentPlansPerOrganisation: zPositiveInt().default(16),
});

// The defaults are this build's choices: the spec names the bounds, not their values.
export type ExecutorBounds = z.output<typeof schema>;

export function loadExecutorBounds(env: Env, problems: string[]): ExecutorBounds | undefined {
  return parseSection(schema, {
    maxRowsPerSourceStep: read(env, 'EXECUTOR_MAX_ROWS_PER_SOURCE_STEP'),
    maxResultRows: read(env, 'EXECUTOR_MAX_RESULT_ROWS'),
    localStepBytes: read(env, 'EXECUTOR_LOCAL_STEP_BYTES'),
    wallTimeMs: read(env, 'EXECUTOR_WALL_TIME_MS'),
    fanOutPerHop: read(env, 'EXECUTOR_FAN_OUT_PER_HOP'),
    concurrentPlansPerOrganisation: read(env, 'EXECUTOR_CONCURRENT_PLANS_PER_ORGANISATION'),
  }, {
    maxRowsPerSourceStep: 'EXECUTOR_MAX_ROWS_PER_SOURCE_STEP', maxResultRows: 'EXECUTOR_MAX_RESULT_ROWS',
    localStepBytes: 'EXECUTOR_LOCAL_STEP_BYTES',
    wallTimeMs: 'EXECUTOR_WALL_TIME_MS', fanOutPerHop: 'EXECUTOR_FAN_OUT_PER_HOP',
    concurrentPlansPerOrganisation: 'EXECUTOR_CONCURRENT_PLANS_PER_ORGANISATION',
  }, problems);
}
