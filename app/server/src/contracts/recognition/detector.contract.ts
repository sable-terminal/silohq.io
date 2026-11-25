// Detectors and their runs (spec 38.2, 38.4, 38.5, 38.11).
//
// Ten detectors exist, Silo-authored and global (recognition.detectors). Each computes a
// fact, never a judgement, and no model takes part (38.4): the same inputs, threshold and
// detector version give the same findings. A detector declares what it needs; an object
// type's configuration names the properties (by identity) and time field it examines, and
// may disable it. A run states what each detector did (38.2 run states) rather than
// silently producing fewer findings, and is recorded even when it produced nothing.
//
// A run reads the population through the executor under the runner's own access: a
// property the runner cannot see, or sees masked or redacted, is not examined.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const RUN_STATES = ['ran', 'not_configured', 'accumulating_baseline', 'history_unavailable', 'source_unreachable', 'bounded'] as const;
export type RunState = (typeof RUN_STATES)[number];

const detectorKey = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);

export const detectorView = z.object({
  id: z.uuid(),
  key: detectorKey,
  name: z.string(),
  description: z.string(),
  executionMode: z.enum(['federated', 'history']),
  requiresProperty: z.boolean(),
  requiresTimeField: z.boolean(),
  minimumBaseline: z.object({ amount: z.number(), unit: z.enum(['days', 'transitions']) }).nullable(),
  version: z.string(),
});
export type DetectorView = z.infer<typeof detectorView>;

export const configurationView = z.object({
  id: z.uuid(),
  detector: detectorKey,
  objectTypeId: z.uuid(),
  /** Property identity ids the detector examines. */
  properties: z.array(z.uuid()),
  timeField: z.uuid().nullable(),
  enabled: z.boolean(),
  version: z.int(),
  updatedAt: z.string(),
});
export type ConfigurationView = z.infer<typeof configurationView>;

export const runView = z.object({
  runId: z.uuid(),
  detector: detectorKey,
  detectorVersion: z.string(),
  objectTypeId: z.uuid(),
  /** Property API names examined (names only). */
  properties: z.array(z.string()),
  state: z.enum(RUN_STATES),
  /** Identifiers and counts: the unreachable connections, the bound and what was seen, what was not configured. */
  stateDetail: z.record(z.string(), z.json()).nullable(),
  populationCount: z.int().nullable(),
  /** accumulating_baseline only: how much history exists and how much is needed. */
  baseline: z.object({ have: z.number(), need: z.number(), unit: z.string() }).nullable(),
  findingsCount: z.int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type RunView = z.infer<typeof runView>;

const CALLERS = ['gateway', 'scheduler', 'fde-orchestrator'] as const;

export const listDetectors = defineContract({
  service: 'recognition', name: 'listDetectors', method: 'GET', path: '/v1/recognition/detectors', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ detectors: z.array(detectorView) }),
});

/** recognition.configure: name the properties and time field a detector examines on a type, or disable it. */
export const configureDetector = defineContract({
  service: 'recognition', name: 'configureDetector', method: 'PUT', path: '/v1/recognition/object-types/:objectTypeId/detectors/:detector',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid(), detector: detectorKey }),
  body: z.strictObject({
    properties: z.array(z.uuid()).max(50).default([]),
    timeField: z.uuid().nullable().default(null),
    enabled: z.boolean().default(true),
    /** The configuration's version when read, to refuse a lost update; absent when creating. */
    version: z.int().min(1).optional(),
  }),
  response: configurationView,
});

export const listConfigurations = defineContract({
  service: 'recognition', name: 'listConfigurations', method: 'GET', path: '/v1/recognition/object-types/:objectTypeId/detectors',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid() }),
  response: z.object({ configurations: z.array(configurationView) }),
});

/** recognition.run: run detectors on demand over an object type, within the runner's visibility. */
export const runDetectors = defineContract({
  service: 'recognition', name: 'runDetectors', method: 'POST', path: '/v1/recognition/runs',
  callers: CALLERS, shed: 'recognition_run', context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    /** The detectors to run; every enabled one when absent. */
    detectors: z.array(detectorKey).min(1).max(20).optional(),
  }),
  response: z.object({
    runs: z.array(runView),
    /** Detectors disabled on this type, not run. */
    disabled: z.array(detectorKey),
  }),
  maxBodyBytes: 4096,
});

export const getRun = defineContract({
  service: 'recognition', name: 'getRun', method: 'GET', path: '/v1/recognition/runs/:runId',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runId: z.uuid() }),
  response: runView,
});
