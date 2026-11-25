// State rules (spec 28.4) and staleness (28.5): how a clone's visual state is derived.
//
// A state rule belongs to one object type and maps its declared input properties to one of
// three rule states (normal, warning, failed) through ordered CEL conditions; unknown and
// stale are never written, they are what evaluation yields when it cannot answer:
// - rules are ordered and the first true condition wins; no condition true is normal;
// - a condition may read only declared inputs, as self.<apiName>, and now (a timestamp);
//   anything else fails validation at save;
// - a condition that reads a null input is unknown, not false, and so is one that reads an
//   input the viewer may not see ("depends on a field not visible to you"); an unknown
//   condition before any true one makes the state unknown, because the earlier rule might
//   have matched;
// - staleness is checked first: a stale input makes the state stale, labelled with the last
//   known state;
// - the state inherits the markings of every input.
// A rule is proposed (by a member holding state_rule.manage, or the AI FDE), then confirmed
// by a person holding state_rule.manage, never a service principal. Confirming replaces the
// type's active rule, which is retired in the same transaction. A confirmed rule's
// conditions, inputs and hash never change.
//
// The compiled hash is SHA-256 over the canonical JSON of the inputs, rules and freshness
// window: the state plane and the client evaluate the same rule only when they agree on it.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

export const CLONE_STATES = ['normal', 'warning', 'failed', 'unknown', 'stale'] as const;
export type CloneState = (typeof CLONE_STATES)[number];
export const RULE_STATES = ['normal', 'warning', 'failed'] as const;

/** Default freshness window of a type with no change stream (spec 28.5): 15 minutes. */
export const DEFAULT_FRESHNESS_SECONDS = 900;

export const stateRuleEntry = z.strictObject({
  state: z.enum(RULE_STATES),
  /** CEL over self (the declared inputs by API name) and now. */
  when: z.string().trim().min(1).max(2_000),
  /** Shown beside the state: configuration a person wrote, never a value. */
  reason: z.string().trim().min(1).max(200),
});
export type StateRuleEntry = z.infer<typeof stateRuleEntry>;

export const stateRuleInput = z.object({
  propertyIdentityId: z.uuid(),
  apiName: z.string(),
  dataType: z.string(),
});

export const stateRuleView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  version: z.int().min(1),
  status: z.enum(['proposed', 'active', 'retired']),
  inputs: z.array(stateRuleInput),
  rules: z.array(stateRuleEntry),
  compiledHash: z.string(),
  freshnessWindowSeconds: z.int(),
  /** Computed from the inputs and the type, never supplied. */
  markingIds: z.array(z.uuid()),
  proposedBy: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('membership'), membershipId: z.uuid() }),
    z.object({ kind: z.literal('service_principal'), servicePrincipalId: z.uuid() }),
  ]),
  confirmedBy: z.uuid().nullable(),
  confirmedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  createdAt: z.string(),
  lockVersion: z.int(),
});
export type StateRuleView = z.infer<typeof stateRuleView>;

const CALLERS = ['gateway', 'fde-orchestrator'] as const;
const ruleParams = z.strictObject({ ruleId: z.uuid() });

export const proposeStateRule = defineContract({
  service: 'canvas-layout', name: 'proposeStateRule', method: 'POST', path: '/v1/clones/state-rules', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    inputPropertyIds: z.array(z.uuid()).min(1).max(32),
    rules: z.array(stateRuleEntry).min(1).max(32),
    freshnessWindowSeconds: z.int().min(60).max(7 * 86_400).default(DEFAULT_FRESHNESS_SECONDS),
  }),
  response: stateRuleView,
  status: 201,
  maxBodyBytes: 128 * 1024,
});

export const confirmStateRule = defineContract({
  service: 'canvas-layout', name: 'confirmStateRule', method: 'POST', path: '/v1/clones/state-rules/:ruleId/confirm', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: ruleParams,
  body: z.strictObject({ lockVersion: z.int().min(1) }),
  response: stateRuleView,
});

export const retireStateRule = defineContract({
  service: 'canvas-layout', name: 'retireStateRule', method: 'POST', path: '/v1/clones/state-rules/:ruleId/retire', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: ruleParams,
  body: z.strictObject({ lockVersion: z.int().min(1) }),
  response: stateRuleView,
});

export const listStateRules = defineContract({
  service: 'canvas-layout', name: 'listStateRules', method: 'GET', path: '/v1/clones/state-rules', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ objectTypeId: z.uuid() }),
  response: z.object({ rules: z.array(stateRuleView) }),
});

/** The active rule of each type: what the state plane subscribes to and both sides evaluate. */
export const getActiveStateRules = defineContract({
  service: 'canvas-layout', name: 'getActiveStateRules', method: 'POST', path: '/v1/clones/state-rules/active',
  callers: ['gateway', 'state-plane', 'studio', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeIds: z.array(z.uuid()).min(1).max(200) }),
  response: z.object({ rules: z.array(stateRuleView) }),
});

/**
 * States for objects the caller has read (28.4; an app's canvas embed or map, 35.5, which draw
 * from the app's run rather than a live subscription): the type's active rule over the values
 * given, evaluated now. An input the caller did not send, or may not see, gives unknown with
 * that reason; with no active rule, every object is normal and says so. Values are used for
 * this answer and never kept.
 */
export const evaluateCloneStates = defineContract({
  service: 'canvas-layout', name: 'evaluateCloneStates', method: 'POST', path: '/v1/clones/states', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    objects: z.array(z.strictObject({ ref: z.string().min(1).max(500), values: recordValue(z.record(z.string(), z.json())) })).max(20_000),
  }),
  response: z.object({
    /** Whether the type has an active rule. */
    rule: z.boolean(),
    states: z.array(z.object({ ref: z.string(), state: z.enum(CLONE_STATES), reason: z.string() })),
  }),
  maxBodyBytes: 16 * 1024 * 1024,
});

// ----------------------------------------------------------------------------- staleness

export const stalenessThresholdView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  /** Null: every type on the connection. */
  objectTypeId: z.uuid().nullable(),
  thresholdSeconds: z.int(),
  /** Declared by the connection's manifest: the poll interval or webhook heartbeat, or the default freshness window. */
  manifestCadenceSeconds: z.int(),
  /** Spec 28.5's threshold for that cadence: three heartbeats, two polls, 60 seconds for CDC. */
  defaultThresholdSeconds: z.int(),
  /** Longer than the default: stale data held as current for longer. */
  loosened: z.boolean(),
  setBy: z.uuid(),
  setAt: z.string(),
});
export type StalenessThresholdView = z.infer<typeof stalenessThresholdView>;

export const setStalenessThreshold = defineContract({
  service: 'canvas-layout', name: 'setStalenessThreshold', method: 'PUT', path: '/v1/clones/staleness/:connectionId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  body: z.strictObject({
    objectTypeId: z.uuid().optional(),
    thresholdSeconds: z.int().min(10).max(30 * 86_400),
  }),
  response: stalenessThresholdView,
});

export const listStalenessThresholds = defineContract({
  service: 'canvas-layout', name: 'listStalenessThresholds', method: 'GET', path: '/v1/clones/staleness',
  callers: ['gateway', 'state-plane'], context: 'organisation', idempotency: 'none',
  query: z.strictObject({ connectionId: z.uuid().optional() }),
  response: z.object({ thresholds: z.array(stalenessThresholdView) }),
});

// ----------------------------------------------------------------------------- time (30.8)

const timedValue = z.object({ value: z.json(), observedAt: z.string() });

export const objectAt = z.object({
  objectRef: z.string(),
  /** False: first seen after the time ("not yet observed"). */
  observed: z.boolean(),
  /** The type's active rules evaluated over the captured values at the time; null when not observed. */
  state: z.object({ state: z.enum(CLONE_STATES), reason: z.string() }).nullable(),
  /** Captured properties, each with when its value was observed. Record values. */
  values: z.record(z.string(), timedValue),
});

/**
 * Time scrubbing and compare (spec 30.8): a type's objects at a past time, over Capture
 * history only, with states from its active rules; with `compareTo`, the differences
 * between the two times: changed states, changed properties with both values, and objects
 * present at only one time. Without Capture, `available` is false with the reason the bar
 * shows.
 */
export const getCloneStatesAt = defineContract({
  service: 'canvas-layout', name: 'getCloneStatesAt', method: 'POST', path: '/v1/clones/time',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    objectRefs: z.array(z.string().min(1).max(500)).min(1).max(500),
    /** The properties the canvas shows, by API name; the active rule's inputs are read as well. */
    properties: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).max(100).default([]),
    at: z.iso.datetime({ offset: true }),
    compareTo: z.iso.datetime({ offset: true }).optional(),
  }),
  response: z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
    historyBegins: z.string().nullable(),
    gaps: z.array(z.object({ from: z.string(), to: z.string() })),
    /** Inputs of the rules and properties shown: captured, or not captured (never their current value), or withheld. */
    properties: z.array(z.object({ property: z.string(), availability: z.enum(['captured', 'not_captured', 'withheld']) })),
    at: z.array(objectAt),
    compareTo: z.array(objectAt).nullable(),
    differences: z.object({
      states: z.array(z.object({ objectRef: z.string(), at: z.enum(CLONE_STATES), compareTo: z.enum(CLONE_STATES) })),
      properties: z.array(z.object({ objectRef: z.string(), property: z.string(), at: timedValue, compareTo: timedValue })),
      onlyAt: z.array(z.string()),
      onlyCompareTo: z.array(z.string()),
    }).nullable(),
  }),
  maxBodyBytes: 64 * 1024,
});
