// Saved views (spec 37.1 to 37.3, 37.5, 37.6): durable, private by default, owned by one
// membership, re-executed on demand at no metered cost, each its own Ask thread.
//
// A view stores a plan by reference: a compiled manifest (result, analysis) or an object
// set definition (object_set). It never stores result rows; its last result is a data
// plane reference under TTL. Every open and every run is under the opener's own access:
// the executor re-resolves the plan against the opener's permissions, markings,
// connection grants and field policies, and drops what they may not see (spec 37.5).
//
// Who may do what: the owner saves, renames, archives, favourites and shares (ownership is
// the authority; the sharing policies are the limits). A share grants view (the view and
// its last result), run (re-execute against live data) or copy (duplicate into one's own
// views); each level includes the ones before it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const VIEW_KINDS = ['result', 'object_set', 'analysis'] as const;
export const VIEW_ACCESS = ['view', 'run', 'copy'] as const;
export type ViewAccess = (typeof VIEW_ACCESS)[number];

const name = z.string().trim().min(1).max(200);

export const savedViewView = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(VIEW_KINDS),
  /** The compiled manifest, for result and analysis views. */
  manifestId: z.uuid().nullable(),
  /** The object set definition, for object_set views. */
  objectSetId: z.uuid().nullable(),
  /** The view's own Ask thread. */
  threadId: z.uuid(),
  ownerMembershipId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable(),
  /** The owner's flag: the view is on the owner's dashboard. */
  favourited: z.boolean(),
  visibility: z.enum(['private', 'shared', 'org_visible']),
  archivedAt: z.string().nullable(),
  transferredFromMembershipId: z.uuid().nullable(),
  transferredAt: z.string().nullable(),
  lockVersion: z.number().int(),
  /** What the caller holds on it: owner, or the best live share the sharing policy still allows. */
  access: z.enum(['owner', ...VIEW_ACCESS]),
});
export type SavedViewView = z.infer<typeof savedViewView>;

/** The last result, while the data plane holds it (spec 37.2): a reference, never rows. */
export const lastRun = z.object({ resultRef: z.string(), ranAt: z.string() }).nullable();

const CALLERS = ['gateway'] as const;
const viewParams = z.strictObject({ viewId: z.uuid() });

export const saveView = defineContract({
  service: 'workspace', name: 'saveView', method: 'POST', path: '/v1/workspace/views', callers: [...CALLERS, 'ask', 'studio', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  body: z.discriminatedUnion('kind', [
    /** fromBindingId: where the plan's bound values are kept (the Ask turn it came from); the view keeps a copy. */
    z.strictObject({ kind: z.literal('result'), name, manifestId: z.uuid(), fromBindingId: z.uuid().optional() }),
    z.strictObject({ kind: z.literal('analysis'), name, manifestId: z.uuid(), fromBindingId: z.uuid().optional() }),
    z.strictObject({ kind: z.literal('object_set'), name, objectSetId: z.uuid() }),
  ]),
  response: savedViewView, status: 201,
});

export const listViews = defineContract({
  service: 'workspace', name: 'listViews', method: 'GET', path: '/v1/workspace/views', callers: [...CALLERS, 'ask', 'search'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    /** mine: owned and live; shared: shared with me; favourited: on my dashboard; archived: owned and archived. */
    set: z.enum(['mine', 'shared', 'favourited', 'archived']).default('mine'),
    /** Matched against view names (trigram), which the owner chose. */
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ views: z.array(savedViewView) }),
});

export const openView = defineContract({
  service: 'workspace', name: 'openView', method: 'GET', path: '/v1/workspace/views/:viewId', callers: [...CALLERS, 'ask', 'scheduler', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none', params: viewParams,
  response: z.object({ view: savedViewView, lastRun }),
});

export const renameView = defineContract({
  service: 'workspace', name: 'renameView', method: 'PATCH', path: '/v1/workspace/views/:viewId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: viewParams,
  body: z.strictObject({ name, lockVersion: z.number().int().min(1) }),
  response: savedViewView,
});

export const archiveView = defineContract({
  service: 'workspace', name: 'archiveView', method: 'POST', path: '/v1/workspace/views/:viewId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: viewParams, response: savedViewView,
});

const grid = z.tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)]);

export const favouriteView = defineContract({
  service: 'workspace', name: 'favouriteView', method: 'PUT', path: '/v1/workspace/views/:viewId/favourite', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none', params: viewParams,
  body: z.strictObject({ grid: grid.optional() }),
  response: z.object({ view: savedViewView, tileId: z.uuid() }),
});

export const unfavouriteView = defineContract({
  service: 'workspace', name: 'unfavouriteView', method: 'DELETE', path: '/v1/workspace/views/:viewId/favourite', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: viewParams, response: savedViewView,
});

/** The outcome of a run: a result reference, or a refusal naming the reason (spec 27, 37.10). */
export const runOutcome = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('result'),
    resultRef: z.string(),
    ranAt: z.string(),
    /** Part of the view is not visible to the opener and was dropped (spec 37.5). */
    reduced: z.boolean(),
    /** Sources that did not answer within bound, by opaque reference: the incompleteness flag. */
    incompleteSources: z.array(z.string()).max(50),
    /** An analysis ending in a comparison (37.8): the other side, run separately. */
    comparedRef: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.enum(['bound_exceeded', 'capability_missing', 'unsupported', 'invalid_manifest', 'unavailable']),
    /** For invalid_manifest: the ontology version since which the plan no longer validates. */
    invalidSinceVersionId: z.uuid().nullable(),
    /** An analysis (37.8): the step it stopped at; the steps before it remain valid and viewable. */
    step: z.object({ position: z.int(), operation: z.string() }).optional(),
    /** The bound that refused it, and the count that exceeded it, where known. */
    bound: z.object({ name: z.string(), limit: z.number(), observed: z.number().optional() }).optional(),
  }),
]);
export type RunOutcomeView = z.infer<typeof runOutcome>;

export const runView = defineContract({
  service: 'workspace', name: 'runView', method: 'POST', path: '/v1/workspace/views/:viewId/runs', callers: [...CALLERS, 'scheduler'],
  shed: 'view_run', context: 'organisation', idempotency: 'none', params: viewParams,
  response: z.object({ view: savedViewView, run: runOutcome }),
});

export const copyView = defineContract({
  service: 'workspace', name: 'copyView', method: 'POST', path: '/v1/workspace/views/:viewId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params: viewParams,
  body: z.strictObject({ name: name.optional() }),
  response: savedViewView, status: 201,
});

// ----------------------------------------------------------------------------- dashboard

export const dashboardTileView = z.object({
  tileId: z.uuid(),
  grid,
  view: savedViewView,
  lastRun,
});

/** The person's dashboard (spec 37.6): tiles of views they own and favourited, or that are shared with them. */
export const getDashboard = defineContract({
  service: 'workspace', name: 'getDashboard', method: 'GET', path: '/v1/workspace/dashboard', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ tiles: z.array(dashboardTileView) }),
});

export const moveTile = defineContract({
  service: 'workspace', name: 'moveTile', method: 'PUT', path: '/v1/workspace/dashboard/tiles/:tileId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ tileId: z.uuid() }),
  body: z.strictObject({ grid }),
  response: z.object({ tileId: z.uuid(), grid }),
});
