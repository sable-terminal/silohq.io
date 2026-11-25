// Studio apps (spec 35): definitions, versions, review and publication, sharing, templates,
// and opening an app under the viewer's own permissions.
//
// Lifecycle (35.7): draft -> review -> published -> (new draft -> review -> published) ->
// archived; a returned version stays returned and the author continues in a new draft.
// - A draft is editable by its author and named co-editors (edit shares) and is validated
//   on every save; an invalid draft saves with its findings and cannot be submitted.
// - Review freezes the candidate. A reviewer holding app.publish approves or returns it;
//   an author never reviews their own version (the service and a database check). A
//   version is revalidated when it is approved: the ontology may have moved.
// - Rollback puts an earlier definition up for review again as a new version, after
//   revalidation; one that no longer validates cannot be rolled back to.
// - An archived app no longer opens; its versions and audit are kept.
// Sharing (35.8) is the saved-view model (37.4): private by default, shared by the owner
// only, the organisation's policy as ceiling and scope narrowing as floor. view and run
// open and use the published version; copy duplicates it into a draft the recipient owns;
// edit makes the recipient a co-editor of drafts, never a publisher, and is granted to
// named members only (open decision 35.13: this release takes the narrower answer).
// Publishing to a scope (app.publish there, after review) lists the version in that
// subtree's directory and survives the owner's removal; it is refused under the
// explicit_only and disabled sharing policies.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { analysisStep } from '../compile/analysis.contract.ts';
import { RUN_TIMEOUT_MS, runOutcome } from '../executor/result.contract.ts';
import { planParameters, refusal } from '../planner/plan.contract.ts';
import { shareGrantee } from '../workspace/sharing.contract.ts';
import { validationFinding } from './definition.contract.ts';
import { fileView } from '../files/file.contract.ts';

export const APP_ACCESS = ['view', 'run', 'copy', 'edit'] as const;
export type AppAccess = (typeof APP_ACCESS)[number];

export const appVersionView = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  version: z.int(),
  state: z.enum(['draft', 'review', 'published', 'returned', 'superseded']),
  /** As saved: an invalid draft keeps what its author wrote. */
  definition: z.record(z.string(), z.json()),
  schemaVersion: z.string(),
  ontologyVersion: z.int(),
  /** Union of the markings on the elements it references. */
  markings: z.array(z.uuid()),
  findings: z.array(validationFinding),
  rolledBackFromVersion: z.int().nullable(),
  /** The branch whose draft this is (D229); null on main. */
  branchId: z.uuid().nullable(),
  authoredBy: z.uuid(),
  reviewedBy: z.uuid().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  lockVersion: z.int(),
});
export type AppVersionView = z.infer<typeof appVersionView>;

export const appView = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['app', 'object_view_layout']),
  visibility: z.enum(['private', 'shared', 'published']),
  ownerMembershipId: z.uuid(),
  currentVersionId: z.uuid().nullable(),
  generatedBy: z.enum(['ai_fde']).nullable(),
  requireFullClearance: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lockVersion: z.int(),
  /** What the caller holds: owner, a share's access, or published (through a scope). */
  access: z.enum(['owner', ...APP_ACCESS, 'published']),
  /** The open draft, if any, for whoever may edit it. */
  draft: z.object({ version: z.int(), state: z.enum(['draft', 'review', 'returned']), findings: z.int() }).nullable(),
});
export type AppView = z.infer<typeof appView>;

/** What a viewer gets on open: the version, reduced to what they may see, and each widget's standing. */
export const openedApp = z.object({
  app: appView,
  version: z.object({ id: z.uuid(), version: z.int(), ontologyVersion: z.int() }),
  definition: z.record(z.string(), z.json()),
  widgets: z.array(z.object({
    id: z.string(),
    status: z.enum(['available', 'reduced', 'unavailable', 'disabled']),
    reason: z.string().nullable(),
  })),
  /** Elements withheld from this viewer: counted, never named. */
  withheld: z.int(),
  statement: z.string().nullable(),
});
export type OpenedApp = z.infer<typeof openedApp>;

export const TEMPLATES = ['inbox_detail', 'triage_queue', 'monitor', 'map_list', 'scenario_workbench'] as const;

/** Placeholders bind to the customer's own types and Action types (35.9); a template names no domain. */
export const templateBindings = z.strictObject({
  objectTypeId: z.uuid(),
  /** Up to six properties for tables, lists and facets; the type's title first when omitted. */
  properties: z.array(z.uuid()).max(6).optional(),
  actionTypeId: z.uuid().optional(),
  geoPropertyId: z.uuid().optional(),
  measurePropertyId: z.uuid().optional(),
});

const CALLERS = ['gateway'] as const;
const appParams = z.strictObject({ appId: z.uuid() });
const versionParams = z.strictObject({ appId: z.uuid(), version: z.coerce.number().int().min(1) });

export const createApp = defineContract({
  service: 'studio', name: 'createApp', method: 'POST', path: '/v1/studio/apps', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).optional(),
    requireFullClearance: z.boolean().default(false),
    template: z.strictObject({ name: z.enum(TEMPLATES), bindings: templateBindings }).optional(),
    /**
     * An app an AI FDE proposed and a person accepted (50.9): the person owns it; it is marked
     * as generated. Only fde-orchestrator, applying the person's decision, may say so.
     */
    generatedBy: z.literal('ai_fde').optional(),
  }),
  response: z.object({ app: appView, draft: appVersionView }),
  status: 201,
});

/**
 * Validates a definition, or a template's, against main and renders it for the caller (35.6),
 * without saving anything: the AI FDE's check before it proposes an app, and the confirming
 * person's preview under their own permissions (50.9, 51.8). Needs app.create.
 */
export const previewApp = defineContract({
  service: 'studio', name: 'previewApp', method: 'POST', path: '/v1/studio/app-previews', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  body: z.union([
    z.strictObject({ name: z.string().trim().min(1).max(200), template: z.strictObject({ name: z.enum(TEMPLATES), bindings: templateBindings }) }),
    z.strictObject({
      name: z.string().trim().min(1).max(200), definition: z.record(z.string(), z.json()),
      /** Check it as a custom object view layout of this type too (34.6). */
      layoutFor: z.uuid().optional(),
    }),
    /** A custom object view layout's starting point for a type (34.6), with an Action button where one is named. */
    z.strictObject({ name: z.string().trim().min(1).max(200), layout: z.strictObject({ objectTypeId: z.uuid(), actionTypeId: z.uuid().optional() }) }),
  ]),
  response: z.object({
    definition: z.record(z.string(), z.json()),
    findings: z.array(validationFinding),
    markings: z.array(z.uuid()),
    /** As the caller would see it; null when it does not validate, or the caller may not open it at all. */
    rendered: z.object({
      definition: z.record(z.string(), z.json()),
      widgets: z.array(z.object({ id: z.string(), status: z.enum(['available', 'reduced', 'unavailable', 'disabled']), reason: z.string().nullable() })),
      withheld: z.int(),
      statement: z.string().nullable(),
    }).nullable(),
  }),
  maxBodyBytes: 1024 * 1024,
});
export type AppPreview = z.infer<typeof previewApp.response>;

export const listApps = defineContract({
  service: 'studio', name: 'listApps', method: 'GET', path: '/v1/studio/apps', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    filter: z.enum(['mine', 'shared', 'published', 'archived']).default('mine'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ apps: z.array(appView) }),
});

export const getApp = defineContract({
  // workspace: the names of the apps on a person's Home, as they may still open them.
  service: 'studio', name: 'getApp', method: 'GET', path: '/v1/studio/apps/:appId', callers: [...CALLERS, 'workspace'],
  context: 'organisation', idempotency: 'none', params: appParams,
  response: z.object({ app: appView, versions: z.array(appVersionView.omit({ definition: true })) }),
});

export const getAppVersion = defineContract({
  service: 'studio', name: 'getAppVersion', method: 'GET', path: '/v1/studio/apps/:appId/versions/:version', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: versionParams, response: appVersionView,
});

/** Saves the open draft (or opens one); validated on every save, saved with its findings. */
export const saveDraft = defineContract({
  service: 'studio', name: 'saveDraft', method: 'PUT', path: '/v1/studio/apps/:appId/draft', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none', params: appParams,
  body: z.strictObject({
    definition: z.record(z.string(), z.json()),
    /** The draft's lock version when one is open; omitted to open a new draft. */
    lockVersion: z.int().min(1).optional(),
  }),
  response: appVersionView,
  maxBodyBytes: 1024 * 1024,
});

const lockBody = z.strictObject({ lockVersion: z.int().min(1) });

export const submitForReview = defineContract({
  service: 'studio', name: 'submitForReview', method: 'POST', path: '/v1/studio/apps/:appId/versions/:version/submit', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: versionParams, body: lockBody, response: appVersionView,
});

export const approveVersion = defineContract({
  service: 'studio', name: 'approveVersion', method: 'POST', path: '/v1/studio/apps/:appId/versions/:version/approve', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: versionParams,
  body: lockBody.extend({
    scopeId: z.uuid().optional(),
    /**
     * Rolled out in stages (D230): each stage's scopes, with their subtrees, open the new version once
     * that stage is released, the first at approval; everyone else keeps the version before until the last.
     */
    stages: z.array(z.strictObject({ scopeIds: z.array(z.uuid()).min(1).max(20) })).min(1).max(5).optional(),
  }),
  response: appVersionView,
});

export const returnVersion = defineContract({
  service: 'studio', name: 'returnVersion', method: 'POST', path: '/v1/studio/apps/:appId/versions/:version/return', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: versionParams, body: lockBody, response: appVersionView,
});

export const rollbackApp = defineContract({
  service: 'studio', name: 'rollbackApp', method: 'POST', path: '/v1/studio/apps/:appId/rollbacks', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  body: z.strictObject({ toVersion: z.int().min(1) }),
  response: appVersionView,
  status: 201,
});

export const archiveApp = defineContract({
  service: 'studio', name: 'archiveApp', method: 'POST', path: '/v1/studio/apps/:appId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams, response: appView,
});

export const openApp = defineContract({
  service: 'studio', name: 'openApp', method: 'GET', path: '/v1/studio/apps/:appId/open', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  /** A draft's number: its author and co-editors preview it. Otherwise the published version. */
  query: z.strictObject({ version: z.coerce.number().int().min(1).optional() }),
  response: openedApp,
});

/** An app's parameter variables, by name: a value, or null when unset. */
const parameterValues = z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), z.union([z.string().max(1_000), z.number(), z.boolean(), z.null()])).default({});

/**
 * One of an app's object set variables run for the viewer (35.2, 35.6; W9): the definition the
 * version holds, under the viewer's own access, its parameter variables' values bound by name.
 * Members are never stored: every run evaluates the definition again. The answer is complete or
 * refused, never truncated (35.5), and its further pages are read as any result's.
 */
export const runAppVariable = defineContract({
  service: 'studio', name: 'runAppVariable', method: 'POST', path: '/v1/studio/apps/:appId/variables/:variable/runs', callers: CALLERS,
  shed: 'view_run', context: 'organisation', idempotency: 'none',
  params: z.strictObject({ appId: z.uuid(), variable: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/) }),
  body: z.strictObject({
    /** A draft's number, for its author and co-editors; otherwise the published version. */
    version: z.int().min(1).optional(),
    /** Property identities to show besides the title. */
    select: z.array(z.uuid()).max(50).default([]),
    /** The app's parameter variables, by name: a value, or null when unset. */
    parameters: parameterValues,
  }),
  response: runOutcome,
  timeoutMs: RUN_TIMEOUT_MS,
  maxBodyBytes: 16_384,
});

/** A chart of an app, as its viewer has it: the version, their parameter values and their filter controls' narrowing. */
export const chartAsViewed = z.strictObject({
  version: z.int().min(1).optional(),
  parameters: parameterValues,
  /** The filter controls over the chart's set: each facet's chosen value, and whether a search narrows it (its words are not sent). */
  narrowing: z.strictObject({ facets: z.record(z.uuid(), z.string().max(1_000)).default({}), searched: z.boolean().default(false) }).optional(),
});

/**
 * A chart of an app as the steps of an analysis (spec 37.8: an analysis is built from Explorer, an
 * object view link group, Ask or a Studio chart): its set's type with the filter made typed
 * filters, each link the set follows, the viewer's facet narrowing, then the chart's measure by its
 * grouping. The app's literals and the viewer's parameter values become the steps' parameters,
 * never written into them (analysis_steps hold placeholders only). A filter with no typed form, or
 * one that reads now, is said not to be steps, naming the part, rather than changed; a step that
 * keeps a different set from the chart's says so in a note.
 */
export const appChartSteps = defineContract({
  service: 'studio', name: 'appChartSteps', method: 'POST', path: '/v1/studio/apps/:appId/charts/:widgetId/steps', callers: ['workspace'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ appId: z.uuid(), widgetId: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }),
  body: chartAsViewed,
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('steps'), steps: z.array(analysisStep).min(1), parameters: planParameters, notes: z.array(z.string()) }),
    z.object({ outcome: z.literal('not_steps'), refusal }),
  ]),
  maxBodyBytes: 32_768,
});

/** A runtime value of a variable, as the app's expressions read it: a parameter's value, a selection's object ids, otherwise null. */
const runtimeValue = z.union([z.string().max(1_000), z.number(), z.boolean(), z.null(), z.array(z.string().max(100)).max(1_000)]);

/**
 * The app's visibility rules and event conditions evaluated against the viewer's current variable
 * values (35.2, 35.4; W9): the same CEL and bounds the validator compiles them with, so a rule
 * means the same in every client. An expression that fails to evaluate does not hold.
 */
export const evaluateAppExpressions = defineContract({
  service: 'studio', name: 'evaluateAppExpressions', method: 'POST', path: '/v1/studio/apps/:appId/expressions', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  body: z.strictObject({
    version: z.int().min(1).optional(),
    values: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), runtimeValue).default({}),
  }),
  response: z.object({
    /** Widgets with a visibility rule, by id. */
    widgets: z.record(z.string(), z.boolean()),
    /** Event bindings with a condition, by their position in the definition. */
    events: z.record(z.string(), z.boolean()),
  }),
  maxBodyBytes: 64 * 1024,
});

export const appShareView = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  grantee: shareGrantee,
  access: z.enum(APP_ACCESS),
  sharedBy: z.uuid(),
  sharedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  state: z.enum(['live', 'revoked', 'expired', 'suspended', 'forbidden_by_policy']),
});

export const shareApp = defineContract({
  service: 'studio', name: 'shareApp', method: 'PUT', path: '/v1/studio/apps/:appId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(APP_ACCESS), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: appShareView,
});

export const revokeAppShare = defineContract({
  service: 'studio', name: 'revokeAppShare', method: 'POST', path: '/v1/studio/apps/:appId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ appId: z.uuid(), shareId: z.uuid() }), response: appShareView,
});

export const listAppShares = defineContract({
  service: 'studio', name: 'listAppShares', method: 'GET', path: '/v1/studio/apps/:appId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams, response: z.object({ shares: z.array(appShareView) }),
});

export const copyApp = defineContract({
  service: 'studio', name: 'copyApp', method: 'POST', path: '/v1/studio/apps/:appId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params: appParams,
  body: z.strictObject({ name: z.string().trim().min(1).max(200) }),
  response: z.object({ app: appView, draft: appVersionView }),
  status: 201,
});

export const appPublicationView = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  appVersionId: z.uuid(),
  scopeId: z.uuid(),
  mobileEnabled: z.boolean(),
  publishedBy: z.uuid(),
  publishedAt: z.string(),
  withdrawnAt: z.string().nullable(),
});

export const publishToScope = defineContract({
  service: 'studio', name: 'publishToScope', method: 'POST', path: '/v1/studio/apps/:appId/publications', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  body: z.strictObject({ scopeId: z.uuid(), mobileEnabled: z.boolean().default(false) }),
  response: appPublicationView,
  status: 201,
});

/**
 * An app's live publications (35.8): every one for whoever may edit the app; otherwise those the
 * caller may withdraw (their own, or on a scope where they hold app.manage). Withdrawn ones are
 * in the audit log.
 */
export const listPublications = defineContract({
  service: 'studio', name: 'listPublications', method: 'GET', path: '/v1/studio/apps/:appId/publications', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams, response: z.object({ publications: z.array(appPublicationView) }),
});

export const withdrawPublication = defineContract({
  service: 'studio', name: 'withdrawPublication', method: 'POST', path: '/v1/studio/apps/:appId/publications/:publicationId/withdraw',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ appId: z.uuid(), publicationId: z.uuid() }),
  response: appPublicationView,
});

export const listTemplates = defineContract({
  service: 'studio', name: 'listTemplates', method: 'GET', path: '/v1/studio/templates', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    templates: z.array(z.object({
      name: z.enum(TEMPLATES),
      description: z.string(),
      /** The bindings it needs; the rest are optional. */
      requires: z.array(z.enum(['objectTypeId', 'actionTypeId', 'geoPropertyId', 'measurePropertyId'])),
    })),
  }),
});

// ----------------------------------------------------------------------------- branches (D229)
// An app branch is a line of work beside main with one draft of its own, opened from the
// published version by an editor, optionally built on an open ontology branch (its draft then
// validates against that branch's ontology). It never goes to review itself: it merges into
// main's next draft by a three-way merge of the definitions' structure, each conflict decided by
// a person, and that draft takes main's review. A branch on an ontology branch merges only once
// that branch has merged.

export const appBranchView = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  name: z.string(),
  status: z.enum(['open', 'merged', 'abandoned']),
  ontologyBranchId: z.uuid().nullable(),
  /** The published version it was opened from. */
  baseVersion: z.int().nullable(),
  draftVersion: z.int().nullable(),
  /** Main's draft its merge became. */
  mergedVersion: z.int().nullable(),
  createdBy: z.uuid(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  lockVersion: z.int(),
});
export type AppBranchView = z.infer<typeof appBranchView>;

const branchParams = z.strictObject({ appId: z.uuid(), branchId: z.uuid() });
const definitionChange = z.object({ path: z.string(), change: z.enum(['added', 'removed', 'changed']) });

export const listAppBranches = defineContract({
  service: 'studio', name: 'listAppBranches', method: 'GET', path: '/v1/studio/apps/:appId/branches', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams, response: z.object({ branches: z.array(appBranchView) }),
});

export const openAppBranch = defineContract({
  service: 'studio', name: 'openAppBranch', method: 'POST', path: '/v1/studio/apps/:appId/branches', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  body: z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), ontologyBranchId: z.uuid().optional() }),
  response: z.object({ branch: appBranchView, draft: appVersionView }), status: 201,
});

export const saveAppBranchDraft = defineContract({
  service: 'studio', name: 'saveAppBranchDraft', method: 'PUT', path: '/v1/studio/apps/:appId/branches/:branchId/draft', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: branchParams,
  body: z.strictObject({ definition: z.record(z.string(), z.json()), lockVersion: z.int().min(1) }),
  response: appVersionView, maxBodyBytes: 1024 * 1024,
});

/** What changed from one version to another, element by element (the paths a merge names). */
export const compareAppVersions = defineContract({
  service: 'studio', name: 'compareAppVersions', method: 'GET', path: '/v1/studio/apps/:appId/comparisons', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams,
  query: z.strictObject({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }),
  response: z.object({ changes: z.array(definitionChange) }),
});

/** The branch into main's next draft; the conflicts, both sides shown, until each is decided. */
export const mergeAppBranch = defineContract({
  service: 'studio', name: 'mergeAppBranch', method: 'POST', path: '/v1/studio/apps/:appId/branches/:branchId/merge', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: branchParams,
  body: z.strictObject({
    lockVersion: z.int().min(1),
    decisions: z.array(z.strictObject({ path: z.string().min(1).max(400), take: z.enum(['main', 'branch']) })).max(500).default([]),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('conflicts'), conflicts: z.array(z.object({ path: z.string(), base: z.json().optional(), main: z.json().optional(), branch: z.json().optional() })) }),
    z.object({ outcome: z.literal('merged'), branch: appBranchView, draft: appVersionView }),
  ]),
});

export const abandonAppBranch = defineContract({
  service: 'studio', name: 'abandonAppBranch', method: 'POST', path: '/v1/studio/apps/:appId/branches/:branchId/abandon', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: branchParams, body: z.strictObject({ lockVersion: z.int().min(1) }), response: appBranchView,
});

// ----------------------------------------------------------------------------- staged releases (D230)
// A version approved with stages is published, and the app's latest release decides who opens it:
// a member of a released stage's scopes (or below one) opens the new version, everyone else the
// version before, until the last stage is released; rolled back, everyone opens the version
// before. Editors (owner and edit shares) always open the newest. One release rolls out at a time.

export const appReleaseView = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  toVersion: z.int(),
  fromVersion: z.int(),
  status: z.enum(['rolling_out', 'complete', 'rolled_back']),
  stages: z.array(z.object({ ordinal: z.int(), scopeIds: z.array(z.uuid()), releasedAt: z.string().nullable(), releasedBy: z.uuid().nullable() })),
  startedBy: z.uuid(),
  startedAt: z.string(),
  closedAt: z.string().nullable(),
  lockVersion: z.int(),
});
export type AppReleaseView = z.infer<typeof appReleaseView>;
const releaseParams = z.strictObject({ appId: z.uuid(), releaseId: z.uuid() });

export const listAppReleases = defineContract({
  service: 'studio', name: 'listAppReleases', method: 'GET', path: '/v1/studio/apps/:appId/releases', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: appParams, response: z.object({ releases: z.array(appReleaseView) }),
});

/** The next stage released (app.publish in each of its scopes); the last completes the release. */
export const promoteAppRelease = defineContract({
  service: 'studio', name: 'promoteAppRelease', method: 'POST', path: '/v1/studio/apps/:appId/releases/:releaseId/promote', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: releaseParams, body: lockBody, response: appReleaseView,
});

/** Everyone back on the version before; the new one stays published for its editors to fix. */
export const rollBackAppRelease = defineContract({
  service: 'studio', name: 'rollBackAppRelease', method: 'POST', path: '/v1/studio/apps/:appId/releases/:releaseId/roll-back', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: releaseParams, body: lockBody, response: appReleaseView,
});

// ----------------------------------------------------------------------------- packages (D231)
// An app moved to another organisation (a test cell's to a production cell's): exported as a
// package into Files, carrying the version's markings, its definition and every ontology element
// it names by API name; imported, each element is found by that name in the receiving ontology
// and its id put in place, and the draft is validated there. What is not found is named.

const packageReference = z.strictObject({
  id: z.uuid(), kind: z.enum(['object_type', 'property', 'link_type', 'function', 'action_type', 'shared_property']),
  apiName: z.string().min(1).max(200), objectType: z.string().min(1).max(200).optional(),
});
export const appPackage = z.strictObject({
  format: z.literal('silo.app-package'),
  formatVersion: z.literal(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  /** The markings the package carries, by name: printed, as every export prints its markings. */
  markings: z.array(z.string()).max(100),
  sourceVersion: z.int().min(1),
  exportedAt: z.string(),
  definition: z.record(z.string(), z.json()),
  references: z.array(packageReference).max(2_000),
});
export type AppPackage = z.infer<typeof appPackage>;
const unmappedReference = z.object({ kind: packageReference.shape.kind, apiName: z.string(), objectType: z.string().optional() });

export const exportAppPackage = defineContract({
  service: 'studio', name: 'exportAppPackage', method: 'POST', path: '/v1/studio/apps/:appId/packages', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params: appParams,
  body: z.strictObject({ version: z.int().min(1).optional(), folderId: z.uuid().optional() }),
  response: z.object({ file: fileView, references: z.int(), unresolved: z.int() }), status: 201,
});

export const importAppPackage = defineContract({
  service: 'studio', name: 'importAppPackage', method: 'POST', path: '/v1/studio/app-packages', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    package: z.record(z.string(), z.json()),
    /** A new app's name; the package's when omitted. */
    name: z.string().trim().min(1).max(200).optional(),
    /** An existing app of which the import becomes main's next draft. */
    appId: z.uuid().optional(),
  }),
  // A keyed retry answers the app and draft the first request made; what was not found is then read from the draft's findings.
  response: z.object({ app: appView, draft: appVersionView, mapped: z.int(), unmapped: z.array(unmappedReference) }), status: 201,
  maxBodyBytes: 2 * 1024 * 1024,
});

