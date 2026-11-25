// Siloes (spec 66, 67, 70; catalogue: siloes-capture): the organisation's switch, the Siloes
// page, Capture, the history read, retention and every wipe.
//
// - The switch (silo.enable, super admin only): off means unreachable. No Silo endpoint of
//   any Silo service answers while it is off, and it can be turned off only once every Silo
//   has been disabled and purged (70.4).
// - A Silo is created for a stated purpose with a retention window, never defaulted; object
//   types are added one at a time with their properties, nothing cascading, and only by a
//   person who can see them (66.6, 66.10). Every view carries its disclosure (70.6).
// - Retention: shortening needs silo.purge, lengthening silo.manage; both audited with both
//   windows (70.1). A daily sweep enforces it for every Silo type.
// - Wipes (70.2, 70.3) are distinct scopes, never one button. Each drains the capture queue
//   first, routes through an approval chain where the organisation has a default approval
//   policy, deletes from every store the scope touches, and leaves a receipt of references
//   and counts with the capabilities that stop working.
// - Capture (67): the executor queues what it observed; this service compares with the
//   baseline and writes a transition only for a change, never on first sighting. History is
//   read here, through the reader's own access, and a baseline still building is said so.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const instant = z.string();
const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const properties = z.array(apiName).min(1).max(100).refine((p) => new Set(p).size === p.length, 'a property is nominated once');
const retentionDays = z.int().min(1).max(36_500);
const siloParams = z.strictObject({ siloId: z.uuid() });

export const SILO_KINDS = ['capture', 'import', 'object_index', 'warehouse'] as const;
export const PURGE_SCOPES = ['entity', 'file', 'object', 'index', 'concept', 'silo'] as const;
export type PurgeScope = (typeof PURGE_SCOPES)[number];

export const siloView = z.object({
  id: z.uuid(),
  kind: z.enum(SILO_KINDS),
  name: z.string(),
  purpose: z.string(),
  retentionDays: z.int(),
  location: z.string(),
  status: z.enum(['provisioning', 'active', 'purging', 'disabled']),
  /** The backing store's name: a dataset, or pg-capture. */
  store: z.string().nullable(),
  createdAt: instant,
  disabledAt: instant.nullable(),
  objectTypes: z.array(z.object({ objectTypeId: z.uuid(), properties: z.array(z.string()), addedAt: instant })),
  /** The latest measurement: bytes held, and when. */
  size: z.object({ bytes: z.string(), measuredAt: instant }).nullable(),
  /** What is kept, where, for how long, and that it is deletable (70.6). Shown at every change. */
  disclosure: z.string(),
  /** Whether this Silo holds the organisation's Action ledger, and with values (48.2; D205). */
  actionLedger: z.enum(['off', 'references', 'values']),
});
export type SiloView = z.infer<typeof siloView>;

export const purgeImpact = z.object({
  /** History detectors that stop working, by object type. */
  detectors: z.array(z.object({ detector: z.string(), objectTypeId: z.uuid() })),
  timelines: z.array(z.uuid()),
  leadTimes: z.array(z.uuid()),
  searchRoutes: z.array(z.uuid()),
  warehouse: z.boolean(),
  importedRows: z.boolean(),
});
export type PurgeImpact = z.infer<typeof purgeImpact>;

export const purgeView = z.object({
  id: z.uuid(),
  siloId: z.uuid(),
  scope: z.enum(PURGE_SCOPES),
  objectTypeId: z.uuid().nullable(),
  fileId: z.uuid().nullable(),
  objectRef: z.string().nullable(),
  status: z.enum(['awaiting_approval', 'approved', 'rejected', 'running', 'completed', 'failed', 'cancelled']),
  approvalChainId: z.uuid().nullable(),
  /** What an approver quotes to approve this wipe and no other: the hash of its document. */
  documentHash: z.string().nullable(),
  requestedAt: instant,
  completedAt: instant.nullable(),
  failureStage: z.string().nullable(),
  impact: purgeImpact,
  receipt: z.object({
    id: z.uuid(),
    /** References and counts per store; never a value. */
    removed: z.record(z.string(), z.unknown()),
    counts: z.record(z.string(), z.number()),
    completedAt: instant,
  }).nullable(),
});
export type PurgeView = z.infer<typeof purgeView>;

// ----------------------------------------------------------------------------- the switch

export const getSiloesSetting = defineContract({
  service: 'siloes-capture', name: 'getSiloesSetting', method: 'GET', path: '/v1/siloes/setting',
  // The workspace asks whether the rail shows Siloes (spec 33.3).
  callers: ['gateway', 'workspace'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ enabled: z.boolean(), disclosure: z.string() }),
});

export const setSiloesEnabled = defineContract({
  service: 'siloes-capture', name: 'setSiloesEnabled', method: 'POST', path: '/v1/siloes/setting',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ enabled: z.boolean() }),
  response: z.object({ enabled: z.boolean(), disclosure: z.string() }),
});

// ----------------------------------------------------------------------------- Siloes

export const listSiloes = defineContract({
  service: 'siloes-capture', name: 'listSiloes', method: 'GET', path: '/v1/siloes',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ includeDisabled: z.enum(['true', 'false']).default('false') }),
  response: z.object({ siloes: z.array(siloView) }),
});

/**
 * The Siloes page (66.9): every Silo with what it holds, when it last took data in, its size,
 * retention window and purpose, and the links between Siloes and why: two Siloes that hold
 * the same object type, or object types a link type joins, so retrieval from one reaches the
 * other without a second query. A list where nothing links: there is nothing to see in a graph.
 */
export const getSiloesWeb = defineContract({
  service: 'siloes-capture', name: 'getSiloesWeb', method: 'GET', path: '/v1/siloes/web',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    siloes: z.array(siloView.extend({
      /** The object types it holds, as the reader's ontology names them (an Import Silo's: those its objects are mapped to). */
      heldTypeIds: z.array(z.uuid()),
      lastUpdatedAt: instant.nullable(),
    })),
    links: z.array(z.object({
      from: z.uuid(),
      to: z.uuid(),
      why: z.array(z.enum(['same_type', 'linked_types'])),
      objectTypeIds: z.array(z.uuid()),
      linkTypeIds: z.array(z.uuid()),
    })),
    presentation: z.enum(['graph', 'list']),
  }),
});

export const getSilo = defineContract({
  service: 'siloes-capture', name: 'getSilo', method: 'GET', path: '/v1/siloes/:siloId',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  response: siloView,
});

export const createCaptureSilo = defineContract({
  service: 'siloes-capture', name: 'createCaptureSilo', method: 'POST', path: '/v1/siloes/capture',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ name: z.string().trim().min(1).max(200), purpose: z.string().trim().min(1).max(2000), retentionDays }),
  response: siloView, status: 201,
});

export const addCaptureType = defineContract({
  service: 'siloes-capture', name: 'addCaptureType', method: 'POST', path: '/v1/siloes/:siloId/types',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({ objectTypeId: z.uuid(), properties }),
  response: siloView, status: 201,
});

export const changeCaptureProperties = defineContract({
  service: 'siloes-capture', name: 'changeCaptureProperties', method: 'POST', path: '/v1/siloes/:siloId/types/:objectTypeId/properties',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams.extend({ objectTypeId: z.uuid() }),
  body: z.strictObject({ properties }),
  response: siloView,
});

export const removeCaptureType = defineContract({
  service: 'siloes-capture', name: 'removeCaptureType', method: 'POST', path: '/v1/siloes/:siloId/types/:objectTypeId/remove',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams.extend({ objectTypeId: z.uuid() }),
  response: siloView,
});

export const changeRetention = defineContract({
  service: 'siloes-capture', name: 'changeRetention', method: 'POST', path: '/v1/siloes/:siloId/retention',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({ retentionDays }),
  response: siloView,
});

// ----------------------------------------------------------------------------- wipes

export const requestPurge = defineContract({
  service: 'siloes-capture', name: 'requestPurge', method: 'POST', path: '/v1/siloes/:siloId/purges',
  // files: deleting an upload is a purge of its Silo file (spec 41.6), in the person's own request.
  callers: ['gateway', 'files'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({
    scope: z.enum(PURGE_SCOPES),
    /** entity and concept: the object type; index: one type's entries, or absent for the whole index. */
    objectTypeId: z.uuid().optional(),
    /** file: the Import file. */
    fileId: z.uuid().optional(),
    /** entity: the object's reference; object: the definition object's name. */
    objectRef: z.string().min(1).max(500).optional(),
  }),
  response: purgeView, status: 201,
});

/** The confirmation screen (70.3 step 5): what would stop working, before anything is requested. */
export const previewPurge = defineContract({
  service: 'siloes-capture', name: 'previewPurge', method: 'POST', path: '/v1/siloes/:siloId/purge-previews',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: requestPurge.body,
  response: z.object({ impact: purgeImpact, approvalsRequired: z.int() }),
});

export const getPurge = defineContract({
  service: 'siloes-capture', name: 'getPurge', method: 'GET', path: '/v1/siloes/:siloId/purges/:purgeId',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams.extend({ purgeId: z.uuid() }),
  response: purgeView,
});

/**
 * A Silo's purges, newest first, without their impact (computed per purge by getPurge): what each
 * was of, its state and whether its receipt is written, so a receipt is found again (D270).
 */
export const listPurges = defineContract({
  service: 'siloes-capture', name: 'listPurges', method: 'GET', path: '/v1/siloes/:siloId/purges',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({
    purges: z.array(z.object({
      id: z.uuid(), scope: z.enum(PURGE_SCOPES), objectTypeId: z.uuid().nullable(), fileId: z.uuid().nullable(), objectRef: z.string().nullable(),
      status: purgeView.shape.status, approvalChainId: z.uuid().nullable(), requestedBy: z.uuid(), requestedAt: z.string(), completedAt: z.string().nullable(),
      failureStage: z.string().nullable(), receipt: z.boolean(),
    })),
  }),
});

// ----------------------------------------------------------------------------- history

export const HISTORY_STATES = ['silo', 'building', 'unavailable', 'withheld'] as const;

/**
 * The history resolver's Silo path (67.4): a property's transitions, as the reader may see
 * them. 'building' when a Capture Silo holds the property but has fewer transitions than the
 * consumer's declared minimum: nothing is returned then, never a thin baseline.
 */
export const readHistory = defineContract({
  service: 'siloes-capture', name: 'readHistory', method: 'POST', path: '/v1/history',
  // workspace: a process analysis over a state property's captured changes (D234).
  callers: ['gateway', 'recognition', 'canvas-layout', 'simulation', 'state-plane', 'workspace'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    property: apiName,
    objectRefs: z.array(z.string().min(1).max(500)).max(1_000).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    /** The consumer's declared minimum baseline, in transitions. */
    minimumTransitions: z.int().min(0).max(1_000_000).default(0),
    limit: z.int().min(1).max(10_000).default(1_000),
  }),
  response: z.object({
    state: z.enum(HISTORY_STATES),
    siloId: z.uuid().nullable(),
    /** Where captured history begins: the Silo's first transition of the property, or null. */
    capturedFrom: instant.nullable(),
    /** Transitions held for the property (within the window asked). */
    have: z.int(),
    need: z.int(),
    transitions: z.array(z.object({
      objectRef: z.string(),
      /** Record values: the property's previous and new value. */
      previousValue: z.json(),
      newValue: z.json(),
      observedAt: instant,
      connectionId: z.uuid(),
    })),
  }),
  maxBodyBytes: 256 * 1024,
});

/**
 * Time (spec 30.8): objects as Capture saw them at a past time, per nominated property the
 * reader may see: the last value captured at or before it, with when that value was
 * observed. A property the Silo does not nominate is not captured; an object first seen
 * after the time is not yet observed. Reading needs clearance on the Silo as well as the
 * type. Where history begins and where it has gaps (the type was not captured) is stated.
 */
/**
 * The object view's timeline, observed changes (spec 34.4): one object's captured transitions,
 * newest first, across the captured properties the reader may see, each value under the
 * reader's field policy (a masked one shows at most its last four characters, a redacted one
 * nothing, saying which). No Capture Silo holds the type, or Siloes are off: 'unavailable', and
 * the timeline states that changes before the session are not held and history requires
 * Capture. Action commits come from the ledger (listObjectCommits) and are always complete.
 */
export const readObjectChanges = defineContract({
  service: 'siloes-capture', name: 'readObjectChanges', method: 'POST', path: '/v1/object-changes',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    objectId: z.uuid(),
    /** Changes observed before this time: the previous page's next. */
    before: z.iso.datetime({ offset: true }).optional(),
    limit: z.int().min(1).max(200).default(50),
  }),
  response: z.object({
    state: z.enum(['silo', 'unavailable', 'withheld']),
    siloId: z.uuid().nullable(),
    /** Where captured history of the type begins: its Silo's first transition, or null. */
    capturedFrom: instant.nullable(),
    /** The type's captured properties the reader may see, by API name. */
    properties: z.array(apiName),
    changes: z.array(z.object({
      property: apiName,
      /** Record values, under the reader's field policy. */
      previousValue: z.json(),
      newValue: z.json(),
      withheld: z.enum(['mask', 'redact']).nullable(),
      observedAt: instant,
      connectionId: z.uuid(),
    })),
    /** Pass as before for the next page; null at the end. */
    next: instant.nullable(),
  }),
});

/**
 * What Capture holds of a type that the reader may read in full (38.8): its captured
 * properties, visible with no field policy, and where captured history begins. Investigation
 * asks this before it answers a history-dependent part. 'unavailable' where no Capture Silo
 * holds the type or Siloes are off; 'withheld' where the reader may not see the type.
 */
export const readCaptureCoverage = defineContract({
  service: 'siloes-capture', name: 'readCaptureCoverage', method: 'POST', path: '/v1/history/coverage',
  callers: ['recognition'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeId: z.uuid() }),
  response: z.object({
    state: z.enum(['silo', 'unavailable', 'withheld']),
    siloId: z.uuid().nullable(),
    capturedFrom: instant.nullable(),
    properties: z.array(apiName),
  }),
});

export const readStateAt = defineContract({
  service: 'siloes-capture', name: 'readStateAt', method: 'POST', path: '/v1/history/state-at',
  callers: ['canvas-layout'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    objectRefs: z.array(z.string().min(1).max(500)).min(1).max(500),
    properties: z.array(apiName).min(1).max(100),
    at: z.iso.datetime({ offset: true }),
  }),
  response: z.object({
    /** silo: reconstructed; unavailable: no Capture Silo holds the type; withheld: the reader may not see it, or the Silo. */
    state: z.enum(['silo', 'unavailable', 'withheld']),
    reason: z.string().nullable(),
    siloId: z.uuid().nullable(),
    /** The time history begins: the type's first capture, or the Silo's retention edge, whichever is later. */
    historyBegins: instant.nullable(),
    /** Periods the type was not captured. */
    gaps: z.array(z.object({ from: instant, to: instant })),
    properties: z.array(z.object({ property: z.string(), availability: z.enum(['captured', 'not_captured', 'withheld']) })),
    objects: z.array(z.object({
      objectRef: z.string(),
      /** False: first seen after the time (not yet observed). */
      observed: z.boolean(),
      /** Captured properties only. Record values. */
      values: z.record(z.string(), z.object({ value: z.json(), observedAt: instant })),
    })),
  }),
  maxBodyBytes: 256 * 1024,
});

/** An operator, or a test, runs the retention sweep for one organisation now. */
export const runRetentionSweep = defineContract({
  service: 'siloes-capture', name: 'runRetentionSweep', method: 'POST', path: '/v1/retention-sweeps',
  callers: ['admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ siloes: z.array(z.object({ siloId: z.uuid(), kind: z.enum(SILO_KINDS), counts: z.record(z.string(), z.number()) })) }),
});

/**
 * Siloes when the organisation moves cells (spec 6.4; D212): tenant-migrations asks the
 * destination to adopt them (Import rows rebuilt, Index nominations rebuilt, the Warehouse
 * adopted) before the directory names it, and the source to release them (its BigQuery
 * datasets dropped, its Warehouse access revoked) before it purges.
 */
export const adoptMovedSiloes = defineContract({
  service: 'siloes-capture', name: 'adoptMovedSiloes', method: 'POST', path: '/v1/siloes/moved-in',
  callers: ['tenant-migrations'], context: 'organisation', idempotency: 'none',
  response: z.object({ importSilos: z.int(), files: z.int(), rows: z.int(), indexTypes: z.int(), warehouse: z.boolean() }),
});
export const releaseMovedSiloes = defineContract({
  service: 'siloes-capture', name: 'releaseMovedSiloes', method: 'POST', path: '/v1/siloes/moved-out',
  callers: ['tenant-migrations'], context: 'organisation', idempotency: 'none',
  response: z.object({ importDatasets: z.int(), indexDatasets: z.int(), warehouse: z.boolean() }),
});
