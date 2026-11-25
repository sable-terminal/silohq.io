// The workspace shell (spec 33): a person's preferences and Home marker, their favourited
// objects, apps and scenarios, and the organisation's terminology skins.
//
// Preferences and favourites are the person's own records: no permission is asked, and
// every read and change is scoped to the membership in the request context. An object
// favourite stores the reference only, never values (33.10). Skins relabel ontology
// elements for display (33.8): set and superseded with org.terminology.manage, never
// updated in place, and never a new type.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway'] as const;

export const preferencesView = z.object({
  railCollapsed: z.boolean(),
  askPanelOpen: z.boolean(),
  lastHomeSeenAt: z.string().nullable(),
});

export const getPreferences = defineContract({
  service: 'workspace', name: 'getPreferences', method: 'GET', path: '/v1/workspace/preferences', callers: CALLERS,
  context: 'organisation', idempotency: 'none', response: preferencesView,
});

export const updatePreferences = defineContract({
  service: 'workspace', name: 'updatePreferences', method: 'PATCH', path: '/v1/workspace/preferences', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ railCollapsed: z.boolean().optional(), askPanelOpen: z.boolean().optional() }),
  response: preferencesView,
});

/** The briefing was rendered: "since last visit" starts again from now. Returns the previous marker. */
export const markHomeSeen = defineContract({
  service: 'workspace', name: 'markHomeSeen', method: 'POST', path: '/v1/workspace/preferences/home-seen', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ previous: z.string().nullable(), seenAt: z.string() }),
});

/** The left rail (spec 33.3): eleven items in a fixed order, never configurable. */
export const RAIL_ITEMS = ['home', 'explorer', 'clones', 'studio', 'ask', 'scenarios', 'governance', 'connect', 'ontology', 'files', 'siloes'] as const;
export type RailItem = (typeof RAIL_ITEMS)[number];

/**
 * What opens each rail item: any one of these permissions, held where the person works
 * (organisation-wide or on a scope they belong to). None: every member, since what the page
 * shows is filtered by what they may see (Explorer's objects; Studio's apps shared with them;
 * Governance's approvals waiting for them). The class is what the rail names when the item is
 * disabled (spec 33.3: shown disabled with the missing permission class named, not hidden).
 */
export const RAIL_ENTRY: Readonly<Record<RailItem, { class: string; permissions: readonly string[] } | null>> = {
  home: null,
  explorer: null,
  clones: { class: 'clone', permissions: ['clone.view'] },
  studio: null,
  ask: { class: 'query', permissions: ['query.compile'] },
  scenarios: { class: 'simulation', permissions: ['simulation.run'] },
  governance: null,
  connect: {
    class: 'connection',
    permissions: ['connection.create', 'connection.manage', 'connection.grant', 'connection.reconnect', 'connection.credential.rotate', 'agent.view',
      'agent.enrol', 'agent.manage', 'stream.enable', 'stream.manage', 'connector.build', 'connector.edit', 'discovery.manage', 'discovery.review'],
  },
  ontology: { class: 'ontology', permissions: ['ontology.view', 'ontology.propose', 'ontology.manage'] },
  files: { class: 'file', permissions: ['file.upload', 'file.export', 'file.share', 'file.manage', 'file.delete', 'object.export'] },
  siloes: { class: 'silo', permissions: ['silo.create', 'silo.manage', 'silo.import', 'silo.enable', 'silo.purge'] },
};

/**
 * The rail as this person may use it: every item in order, each available or disabled with
 * what it needs. Siloes is absent until a Silo is enabled, since its presence states the
 * organisation's storage posture (spec 66). The person's own view: nothing else is asked.
 */
export const readRail = defineContract({
  service: 'workspace', name: 'readRail', method: 'GET', path: '/v1/workspace/rail', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({
    items: z.array(z.object({
      item: z.enum(RAIL_ITEMS),
      available: z.boolean(),
      /** For a disabled item: the permission class it needs, and the permissions that open it. */
      needs: z.object({ class: z.string(), permissions: z.array(z.string()) }).nullable(),
    })),
  }),
});

// ----------------------------------------------------------------------------- following

/** What a person may follow (decision 2026-11-17): another's Cron, or another's saved object set. */
export const FOLLOW_TYPES = ['cron', 'view'] as const;

export const followView = z.object({ id: z.uuid(), resourceType: z.enum(FOLLOW_TYPES), resourceId: z.uuid(), createdAt: z.string() });
export type FollowView = z.infer<typeof followView>;

/** Follow what the person may see and does not own; following it again returns the follow it has. */
export const followResource = defineContract({
  service: 'workspace', name: 'followResource', method: 'PUT', path: '/v1/workspace/follows', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ resourceType: z.enum(FOLLOW_TYPES), resourceId: z.uuid() }),
  response: followView,
});

export const unfollowResource = defineContract({
  service: 'workspace', name: 'unfollowResource', method: 'DELETE', path: '/v1/workspace/follows/:followId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ followId: z.uuid() }),
  response: followView,
});

export const listFollows = defineContract({
  service: 'workspace', name: 'listFollows', method: 'GET', path: '/v1/workspace/follows', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ follows: z.array(followView) }),
});

// ----------------------------------------------------------------------------- the briefing

/** A briefing section: its items, or that its source could not be read and why (never an empty list in its place). */
const section = <T extends z.ZodType>(item: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(item), more: z.boolean() }),
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
]);

export const briefingView = z.object({
  /** The moment the briefing starts after: the last visit, or null before the first (the last seven days are shown). */
  since: z.string().nullable(),
  generatedAt: z.string(),
  approvals: section(z.object({
    chainId: z.uuid(),
    subjectKind: z.enum(['mutation', 'purge', 'discovery_scan', 'declassification', 'receipt_purge']),
    riskClass: z.enum(['data', 'bulk', 'external', 'physical']).nullable(),
    createdAt: z.string(), expiresAt: z.string(), approvalsRequired: z.int(), approvalsReceived: z.int(),
  })),
  crons: section(z.object({
    cronId: z.uuid(), cronName: z.string(), owned: z.boolean(), runId: z.uuid(),
    trigger: z.enum(['schedule', 'change', 'manual']), status: z.enum(['running', 'completed', 'failed', 'skipped']), startedAt: z.string(),
    conditionOutcome: z.enum(['met', 'not_met', 'indeterminate']).nullable(),
    actions: z.array(z.object({
      kind: z.enum(['notify', 'report', 'mutate', 'escalate']),
      outcome: z.enum(['succeeded', 'failed', 'skipped', 'proposed', 'executed', 'delivered']),
    })),
  })),
  findings: section(z.object({
    findingId: z.uuid(), detector: z.string(), detectorLabel: z.string(), objectTypeId: z.uuid(), objectTypeName: z.string(), objectTypePlural: z.string(),
    objectCount: z.int(), score: z.number(), raisedAt: z.string(),
    /** The object sets the person owns or follows that are of this finding's type. */
    sets: z.array(z.object({ viewId: z.uuid(), name: z.string() })),
  })),
  clones: section(z.object({ favouriteId: z.uuid(), objectTypeId: z.uuid(), objectTypeName: z.string(), objectRef: z.string() })),
  apps: section(z.object({ favouriteId: z.uuid(), appId: z.uuid(), name: z.string() })),
  dashboard: section(z.object({ tileId: z.uuid(), viewId: z.uuid(), name: z.string(), lastRunAt: z.string().nullable() })),
});
export type BriefingView = z.infer<typeof briefingView>;

/** Home's briefing (spec 33.7). Reading it changes nothing; the page marks Home seen once shown (markHomeSeen). */
export const readBriefing = defineContract({
  service: 'workspace', name: 'readBriefing', method: 'GET', path: '/v1/workspace/briefing', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  /** A tab that already showed a briefing keeps its marker, so reloading Home does not empty it. */
  query: z.strictObject({ since: z.iso.datetime({ offset: true }).optional() }),
  response: briefingView,
});

export const favouriteTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('object'), objectTypeId: z.uuid(), objectRef: z.uuid() }),
  z.strictObject({ kind: z.literal('app'), appId: z.uuid() }),
  z.strictObject({ kind: z.literal('scenario'), scenarioId: z.uuid() }),
]);

export const favouriteItemView = z.object({ id: z.uuid(), target: favouriteTarget, position: z.number().int(), createdAt: z.string() });

export const listFavourites = defineContract({
  service: 'workspace', name: 'listFavourites', method: 'GET', path: '/v1/workspace/favourites', callers: CALLERS,
  context: 'organisation', idempotency: 'none', response: z.object({ favourites: z.array(favouriteItemView) }),
});

export const addFavourite = defineContract({
  service: 'workspace', name: 'addFavourite', method: 'POST', path: '/v1/workspace/favourites', callers: CALLERS,
  context: 'organisation', idempotency: 'none', body: z.strictObject({ target: favouriteTarget }),
  response: favouriteItemView, status: 201,
});

export const removeFavourite = defineContract({
  service: 'workspace', name: 'removeFavourite', method: 'DELETE', path: '/v1/workspace/favourites/:favouriteId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ favouriteId: z.uuid() }),
  response: z.object({ removed: z.boolean() }),
});

// ----------------------------------------------------------------------------- skins

export const skinTarget = z.discriminatedUnion('kind', [
  /** A state value is a declared enumeration value of the type, never a record value. */
  z.strictObject({ kind: z.literal('object_type'), objectTypeId: z.uuid(), stateValue: z.string().trim().min(1).max(200).optional() }),
  z.strictObject({ kind: z.literal('link_type'), linkTypeId: z.uuid() }),
  z.strictObject({ kind: z.literal('action_type'), actionTypeId: z.uuid() }),
]);

export const skinView = z.object({
  id: z.uuid(),
  target: skinTarget,
  labelSingular: z.string(),
  labelPlural: z.string().nullable(),
  setBy: z.uuid(),
  setAt: z.string(),
  supersededAt: z.string().nullable(),
});

const label = z.string().trim().min(1).max(100);

export const listTerminologySkins = defineContract({
  service: 'workspace', name: 'listTerminologySkins', method: 'GET', path: '/v1/workspace/terminology-skins',
  callers: [...CALLERS, 'compile', 'ask', 'search', 'render'], context: 'organisation', idempotency: 'none',
  response: z.object({ skins: z.array(skinView) }),
});

/** Sets the live label for an element, superseding the one before it in the same transaction. */
export const setTerminologySkin = defineContract({
  service: 'workspace', name: 'setTerminologySkin', method: 'PUT', path: '/v1/workspace/terminology-skins', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ target: skinTarget, labelSingular: label, labelPlural: label.optional() }),
  response: skinView,
});

export const supersedeTerminologySkin = defineContract({
  service: 'workspace', name: 'supersedeTerminologySkin', method: 'POST', path: '/v1/workspace/terminology-skins/:skinId/supersede',
  callers: CALLERS, context: 'organisation', idempotency: 'none', params: z.strictObject({ skinId: z.uuid() }),
  response: skinView,
});
