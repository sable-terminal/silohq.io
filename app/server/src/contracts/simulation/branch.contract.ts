// Scenario branches (spec 39.8): a branch of the clone state in which Actions are staged,
// never executed. It answers "if we do this, what happens", where a failure scenario answers
// "if this breaks, what happens".
//
// - Staging uses the same Action types and parameters as a real Action: actions compiles
//   the intent, resolves the targets and runs the policy gate in check mode, so a refusal is
//   learned at staging, and reads the touched properties of each target as the branch base
//   (the prior-state rule: touched properties and the identifier, never the whole record).
//   Staging is metered as a compile.
// - Opening recomputes: each staged Action is checked against the record now (three-way:
//   clean, conflicted, already applied, orphaned), its effect applied, and what follows
//   walked over the confirmed graph by every rule of 39.4 and 39.5, as a run of the branch.
//   Opening is metered as a re-run. Branch state is never stored: the branch, its staged
//   Actions and their bases are.
// - Promotion turns staged Actions into proposals through the whole mutation path, with
//   the branch recorded as origin; it never approves them. Nothing in a branch writes to a
//   source.
//
// A branch is its creator's, as its scenario is (sharing is not built). Values (the base,
// the value now, the staged value) appear only in what the opener reads on open and compare.

import { z } from 'zod';
import { objectReference } from '../actions/mutation.contract.ts';
import { defineContract, MAX_TIMEOUT_MS } from '../endpoint.contract.ts';
import { bounds, runView } from './scenario.contract.ts';

export const BRANCH_STATUSES = ['open', 'promoted', 'partially_promoted', 'closed'] as const;
export const STALENESS = ['clean', 'conflicted', 'already_applied', 'orphaned'] as const;
/** How long a closed branch keeps its bases (values) by default: an open decision (39.14), set as receipts are, two years. */
export const DEFAULT_BRANCH_RETENTION_DAYS = 730;

const parameterName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const conflictView = z.object({
  objectId: z.uuid(),
  connectionId: z.uuid(),
  reference: z.string(),
  property: z.string(),
  /** Who changed it since staging, where knowable: a change written through Silo names its proposer; a change made in the source is not knowable. */
  changedBy: z.uuid().nullable(),
  changedByKnown: z.boolean(),
  resolution: z.enum(['keep_staged', 'take_current']).nullable(),
});

export const stagedActionView = z.object({
  id: z.uuid(),
  sequence: z.int(),
  actionTypeId: z.uuid(),
  actionTypeVersionId: z.uuid(),
  objectTypeId: z.uuid(),
  operation: z.enum(['create', 'update_full', 'update_partial', 'delete', 'upsert', 'custom']),
  targets: z.int(),
  /** The touched properties (or fields), by name. */
  properties: z.array(z.string()),
  staleness: z.enum(STALENESS),
  stalenessCheckedAt: z.string().nullable(),
  conflicts: z.array(conflictView),
  /** Physical actuation (chapter 47): simulated here; on promotion two people approve, and the physical effect between execution and revert cannot be undone. */
  physical: z.boolean(),
  statement: z.string().nullable(),
  stagedAt: z.string(),
  promotedActionId: z.uuid().nullable(),
  promotedAt: z.string().nullable(),
});
export type StagedActionView = z.infer<typeof stagedActionView>;

export const branchView = z.object({
  id: z.uuid(),
  scenarioId: z.uuid(),
  name: z.string(),
  /** Carried by every overlay element and every exported page, so a screenshot is identifiable as a branch. */
  label: z.string(),
  status: z.enum(BRANCH_STATUSES),
  retentionDays: z.int(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  basesPurgeAt: z.string().nullable(),
  basesPurged: z.boolean(),
  version: z.int(),
  /** Staged Actions by staleness as last checked, and how many are promoted: partial staleness is first-class. */
  counts: z.object({ clean: z.int(), conflicted: z.int(), alreadyApplied: z.int(), orphaned: z.int(), promoted: z.int() }),
  stagedActions: z.array(stagedActionView),
});
export type BranchView = z.infer<typeof branchView>;

const valueRow = z.object({
  property: z.string(),
  /** Record values: the value now and the branch's (the staged value; null where a custom action's effect is unknown). */
  current: z.json(),
  branch: z.json(),
  branchUnknown: z.boolean(),
  state: z.enum(['clean', 'conflicted', 'already_applied']),
  resolution: z.enum(['keep_staged', 'take_current']).nullable(),
});

export const targetCheckView = z.object({
  objectId: z.uuid(),
  connectionId: z.uuid(),
  reference: z.string(),
  staleness: z.enum(STALENESS),
  /** What the staged Action does here in the walk's terms, or why nothing propagates from it. */
  effect: z.object({ form: z.enum(['unavailable', 'delayed']).nullable(), delay: z.string().nullable(), reason: z.string().nullable() }),
  properties: z.array(valueRow),
});

export const openedBranchView = z.object({
  branch: branchView,
  /** Empty when a retried request is answered from the first: values are read again only on a new open. */
  checks: z.array(z.object({
    stagedActionId: z.uuid(),
    staleness: z.enum(STALENESS),
    /** The policy gate now refuses the staged Action (a grant lost, a connection halted): not promotable until it passes again. */
    refusal: z.object({ stage: z.string(), reason: z.string() }).nullable(),
    targets: z.array(targetCheckView),
  })),
  /** The branch's run: the downstream set, with paths, delays and edge sources, stops and bounds. */
  run: runView,
});
export type OpenedBranchView = z.infer<typeof openedBranchView>;

const objectRef = z.object({ objectTypeId: z.uuid(), objectId: z.uuid() });

export const branchComparison = z.object({
  branchId: z.uuid(),
  against: z.object({ kind: z.enum(['scenario', 'branch']), id: z.uuid() }),
  /** Per target and property of each branch compared: the value now against the branch's. Record values. */
  targets: z.array(z.object({ branchId: z.uuid(), objectId: z.uuid(), property: z.string(), current: z.json(), branch: z.json() })),
  downstream: z.object({
    onlyHere: z.array(objectRef),
    onlyThere: z.array(objectRef),
    /** Affected in both, with the delay in each (ISO 8601; null where the object fails outright). */
    delayChanged: z.array(objectRef.extend({ here: z.string().nullable(), there: z.string().nullable() })),
  }),
  graphChanged: z.boolean(),
  comparable: z.boolean(),
});

export const promotionView = z.object({
  branch: branchView,
  /** Each a proposal awaiting approval through the mutation path; its status is the mutation's. */
  promoted: z.array(z.object({ stagedActionId: z.uuid(), mutationId: z.uuid() })),
  notPromoted: z.array(z.object({
    stagedActionId: z.uuid(),
    reason: z.enum(['conflicted', 'already_applied', 'orphaned', 'refused', 'promoted']),
    statement: z.string(),
    mutationId: z.uuid().nullable(),
  })),
});

const CALLERS = ['gateway'] as const;
const branchId = z.strictObject({ branchId: z.uuid() });
const stagedActionId = z.strictObject({ stagedActionId: z.uuid() });

/** scenario.stage: open a branch from a scenario, or with a new branch scenario (from an object view, a finding or the Clone Canvas). */
export const createBranch = defineContract({
  service: 'simulation', name: 'createBranch', method: 'POST', path: '/v1/simulation/branches', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    from: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('scenario'), scenarioId: z.uuid() }),
      z.strictObject({
        kind: z.enum(['object_view', 'finding', 'canvas']),
        scenario: z.strictObject({
          name: z.string().trim().min(1).max(200),
          mode: z.enum(['deterministic', 'probabilistic']).default('deterministic'),
          bounds: bounds.default({ hops: 4, fanOut: 1_000 }),
        }),
      }),
    ]),
    retentionDays: z.int().min(0).max(3_650).default(DEFAULT_BRANCH_RETENTION_DAYS),
  }),
  response: branchView,
  status: 201,
  maxBodyBytes: 16_384,
});

export const listBranches = defineContract({
  service: 'simulation', name: 'listBranches', method: 'GET', path: '/v1/simulation/scenarios/:scenarioId/branches', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scenarioId: z.uuid() }),
  response: z.object({ branches: z.array(branchView) }),
});

export const getBranch = defineContract({
  service: 'simulation', name: 'getBranch', method: 'GET', path: '/v1/simulation/branches/:branchId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: branchId,
  response: branchView,
});

/** scenario.stage: stage an Action. Keyed: staging is metered as a compile, once. */
export const stageAction = defineContract({
  service: 'simulation', name: 'stageAction', method: 'POST', path: '/v1/simulation/branches/:branchId/staged-actions', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  params: branchId,
  body: z.strictObject({
    actionTypeId: z.uuid(),
    parameters: z.record(parameterName, z.json()).default({}),
    objects: z.array(objectReference).max(10_000).default([]),
    createOn: z.uuid().optional(),
  }),
  response: stagedActionView,
  status: 201,
  maxBodyBytes: 2 * 1024 * 1024,
});

/** scenario.stage: stage again against the record now, so the base is current. Keyed: metered as a compile. */
export const restageAction = defineContract({
  service: 'simulation', name: 'restageAction', method: 'POST', path: '/v1/simulation/staged-actions/:stagedActionId/restage', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  params: stagedActionId,
  response: stagedActionView,
});

/** scenario.stage: decide conflicted properties, per target and property: keep the staged value or take the value now. */
export const resolveStagedConflicts = defineContract({
  service: 'simulation', name: 'resolveStagedConflicts', method: 'POST', path: '/v1/simulation/staged-actions/:stagedActionId/resolutions',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: stagedActionId,
  body: z.strictObject({
    resolutions: z.array(z.strictObject({
      connectionId: z.uuid(), reference: z.string().min(1).max(500), property: z.string().min(1).max(200), choice: z.enum(['keep_staged', 'take_current']),
    })).min(1).max(10_000),
  }),
  response: stagedActionView,
  maxBodyBytes: 2 * 1024 * 1024,
});

/** simulation.run: recompute the branch on current state. Keyed: metered as a re-run, once. */
export const openBranch = defineContract({
  service: 'simulation', name: 'openBranch', method: 'POST', path: '/v1/simulation/branches/:branchId/openings', callers: CALLERS,
  // Opening walks each staged effect as a run of the branch.
  timeoutMs: MAX_TIMEOUT_MS,
  context: 'organisation', idempotency: 'keyed',
  params: branchId,
  response: openedBranchView,
  status: 201,
});

/** Compare a branch with its scenario's latest run, or with another branch of the same scenario, from their latest runs. */
export const compareBranch = defineContract({
  service: 'simulation', name: 'compareBranch', method: 'GET', path: '/v1/simulation/branches/:branchId/comparisons', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: branchId,
  query: z.strictObject({ against: z.uuid().optional() }),
  response: branchComparison,
});

/** scenario.promote: staged Actions to proposals, through the whole mutation path. Never approves. Keyed: a retry proposes once. */
export const promoteBranch = defineContract({
  service: 'simulation', name: 'promoteBranch', method: 'POST', path: '/v1/simulation/branches/:branchId/promotions', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  params: branchId,
  body: z.strictObject({
    stagedActionIds: z.array(z.uuid()).min(1).max(500).optional(),
    /** Promoted from a canvas view overlaying the branch's scenario (30.9): recorded as such. */
    canvasViewId: z.uuid().optional(),
  }),
  response: promotionView,
  status: 201,
});

/** Close a branch: no more staging or promotion; its bases purge when its retention ends. It stays openable until then. */
export const closeBranch = defineContract({
  service: 'simulation', name: 'closeBranch', method: 'POST', path: '/v1/simulation/branches/:branchId/closure', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: branchId,
  body: z.strictObject({ version: z.int().min(1) }),
  response: branchView,
});
