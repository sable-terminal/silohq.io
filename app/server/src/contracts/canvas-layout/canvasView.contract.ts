// Canvas views (spec 29.6, 29.10, 32.6): a saved Clone Canvas configuration (set, layout,
// camera, layers, focus, state filter, pins, scenario overlay). It holds no values: the
// set is a definition (ontology.object_sets), pins are object references, the camera is
// numbers.
//
// - Saving needs canvas.save; sharing needs canvas.share and follows the saved-view sharing
//   model (spec 37.4: private by default, shared by the owner only, the organisation's
//   policy as ceiling and scope narrowing as floor), through workspace.view_shares.
// - Opening re-resolves the set and its type against the opener's own permissions,
//   markings and grants, never the owner's. What they may not see is absent, with a
//   statement; a reduced open is audited (canvas_view_opened_with_reduced_permissions).
//   Cross-organisation sharing is impossible.
// - Favouriting promotes the view to its owner's dashboard; the flag and the tile change in
//   one transaction.
// - A canvas view is an artefact: its lineage (the set it draws) is written with it, as a
//   view node (spec 59.3), so markings on the set's type reach it.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { fileView } from '../files/file.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { shareGrantee, viewShareView } from '../workspace/sharing.contract.ts';
import { VIEW_ACCESS } from '../workspace/view.contract.ts';
import { CLONE_STATES } from './stateRule.contract.ts';
import { CANVAS_LAYOUTS } from './layout.contract.ts';

export const CANVAS_SCOPES = ['object', 'set', 'estate_ontology', 'estate_map'] as const;
export const CANVAS_LAYERS = ['identity', 'live_state', 'history', 'links', 'dependency_edges', 'scenario_overlay'] as const;

const finite = z.number().finite();

export const canvasCamera = z.strictObject({
  centre: z.tuple([finite, finite]).optional(),
  zoom: finite.optional(),
  bearing: finite.optional(),
  pitch: finite.optional(),
  /** The 3D view: position and target. */
  position: z.tuple([finite, finite, finite]).optional(),
  target: z.tuple([finite, finite, finite]).optional(),
});

export const canvasFocus = z.strictObject({
  depth: z.int().min(1).max(3).optional(),
  /** Focal object references. */
  refs: z.array(z.uuid()).max(200).optional(),
});

export const canvasConfiguration = z.strictObject({
  name: z.string().trim().min(1).max(200),
  layoutKind: z.enum(CANVAS_LAYOUTS),
  camera: canvasCamera.default({}),
  layers: z.partialRecord(z.enum(CANVAS_LAYERS), z.boolean()).default({}),
  focus: canvasFocus.default({}),
  stateFilter: z.array(z.enum(CLONE_STATES)).max(CLONE_STATES.length).default([]),
  /** Held on screen and in position (29.6): at most 200. */
  pinnedObjectRefs: z.array(z.uuid()).max(200).default([]),
  scenarioId: z.uuid().optional(),
  /** A site plan drawn under the map layout (29.4): only with spatial_map, and only a live plan whose markings the saver holds. */
  planId: z.uuid().optional(),
  /** The 3D model (29.5): only with spatial_3d, and only a live model whose markings the saver holds. */
  assetModelId: z.uuid().optional(),
});

export const canvasViewView = z.object({
  id: z.uuid(),
  name: z.string(),
  canvasScope: z.enum(CANVAS_SCOPES),
  objectSetId: z.uuid().nullable(),
  layoutKind: z.enum(CANVAS_LAYOUTS),
  camera: canvasCamera,
  layers: z.record(z.string(), z.boolean()),
  focus: canvasFocus,
  stateFilter: z.array(z.enum(CLONE_STATES)),
  pinnedObjectRefs: z.array(z.uuid()),
  scenarioId: z.uuid().nullable(),
  /** The site plan under the map layout; null on open where it was purged or the opener lacks its markings (the map stands instead). */
  planId: z.uuid().nullable(),
  /** The 3D model; null on open where it was purged or the opener lacks its markings (the next layout stands instead). */
  assetModelId: z.uuid().nullable(),
  favourited: z.boolean(),
  visibility: z.enum(['private', 'shared', 'org_visible']),
  /** Main's sequence at save. */
  ontologyVersion: z.int(),
  ownerMembershipId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  lockVersion: z.int(),
  /** What the caller holds on it. */
  access: z.enum(['owner', ...VIEW_ACCESS]),
});
export type CanvasViewView = z.infer<typeof canvasViewView>;

/** What an open resolves for this opener: the view, and what of it they may not see. */
export const openedCanvasView = z.object({
  view: canvasViewView,
  /** The set's base type, when visible to the opener; null when the scope is the estate. */
  objectTypeId: z.uuid().nullable(),
  /** The ontology version the set is resolved against now. */
  ontologyVersionId: z.uuid().nullable(),
  /** Properties of the type the opener may see, with their field policy effect. Withheld ones are absent. */
  visibleProperties: z.array(z.object({ id: z.uuid(), effect: z.enum(['allow', 'mask', 'redact']) })),
  /** Pins that remain: references only; the state plane re-resolves each under the opener. */
  pinnedObjectRefs: z.array(z.uuid()),
  /** Elements withheld from this opener, counted; zero when nothing was. Never named. */
  withheld: z.object({ properties: z.int(), pins: z.int() }),
  /** Spec 57: a statement, never a silent gap. */
  statement: z.string().nullable(),
});
export type OpenedCanvasView = z.infer<typeof openedCanvasView>;

const CALLERS = ['gateway'] as const;
const viewParams = z.strictObject({ canvasViewId: z.uuid() });

export const saveCanvasView = defineContract({
  service: 'canvas-layout', name: 'saveCanvasView', method: 'POST', path: '/v1/canvas/views', callers: [...CALLERS, 'studio', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  body: z.discriminatedUnion('canvasScope', [
    canvasConfiguration.extend({ canvasScope: z.enum(['object', 'set']), objectSetId: z.uuid() }),
    canvasConfiguration.extend({ canvasScope: z.enum(['estate_ontology', 'estate_map']) }),
  ]),
  response: canvasViewView,
  status: 201,
  maxBodyBytes: 64 * 1024,
});

export const updateCanvasView = defineContract({
  service: 'canvas-layout', name: 'updateCanvasView', method: 'PUT', path: '/v1/canvas/views/:canvasViewId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  body: canvasConfiguration.extend({ lockVersion: z.int().min(1) }),
  response: canvasViewView,
  maxBodyBytes: 64 * 1024,
});

export const listCanvasViews = defineContract({
  service: 'canvas-layout', name: 'listCanvasViews', method: 'GET', path: '/v1/canvas/views', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    filter: z.enum(['mine', 'shared', 'favourited', 'archived']).default('mine'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ views: z.array(canvasViewView) }),
});

export const openCanvasView = defineContract({
  service: 'canvas-layout', name: 'openCanvasView', method: 'GET', path: '/v1/canvas/views/:canvasViewId', callers: [...CALLERS, 'studio'],
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  response: openedCanvasView,
});

export const archiveCanvasView = defineContract({
  service: 'canvas-layout', name: 'archiveCanvasView', method: 'POST', path: '/v1/canvas/views/:canvasViewId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  response: canvasViewView,
});

export const favouriteCanvasView = defineContract({
  service: 'canvas-layout', name: 'favouriteCanvasView', method: 'PUT', path: '/v1/canvas/views/:canvasViewId/favourite', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  body: z.strictObject({ grid: z.tuple([z.int().min(1), z.int().min(1), z.int().min(1), z.int().min(1)]).default([1, 1, 4, 3]) }),
  response: canvasViewView,
});

export const unfavouriteCanvasView = defineContract({
  service: 'canvas-layout', name: 'unfavouriteCanvasView', method: 'DELETE', path: '/v1/canvas/views/:canvasViewId/favourite', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  response: canvasViewView,
});

export const shareCanvasView = defineContract({
  service: 'canvas-layout', name: 'shareCanvasView', method: 'PUT', path: '/v1/canvas/views/:canvasViewId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  body: z.strictObject({
    grantee: shareGrantee,
    access: z.enum(VIEW_ACCESS),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
  response: viewShareView,
});

export const revokeCanvasViewShare = defineContract({
  service: 'canvas-layout', name: 'revokeCanvasViewShare', method: 'POST', path: '/v1/canvas/views/:canvasViewId/shares/:shareId/revoke',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ canvasViewId: z.uuid(), shareId: z.uuid() }),
  response: viewShareView,
});

export const listCanvasViewShares = defineContract({
  service: 'canvas-layout', name: 'listCanvasViewShares', method: 'GET', path: '/v1/canvas/views/:canvasViewId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: viewParams,
  response: z.object({ shares: z.array(viewShareView) }),
});

export const renderJobView = z.object({
  id: z.uuid(), canvasViewId: z.uuid(), format: z.literal('png'), width: z.int(), height: z.int(), scale: z.number(),
  status: z.enum(['queued', 'completed', 'failed', 'expired']), fileId: z.uuid().nullable(), failureCode: z.string().nullable(),
  requestedAt: z.string(), completedAt: z.string().nullable(), expiresAt: z.string(),
});

/**
 * Exporting a canvas view (spec 29.10): drawn now for its exporter, under their own access, as
 * a PDF in Files: printed with when it was computed, the state age of each source, its
 * markings, its flags and how many objects could not be placed. A list layout prints as a
 * table. A PNG is drawn by the exporter's own browser (D225): this begins it, saying what the
 * image must print (the markings above all), and the image comes back with completeImageExport.
 */
export const exportCanvasView = defineContract({
  service: 'canvas-layout', name: 'exportCanvasView', method: 'POST', path: '/v1/canvas/views/:canvasViewId/exports', callers: CALLERS,
  shed: 'export_render', context: 'organisation', idempotency: 'keyed',
  params: viewParams,
  body: z.strictObject({
    format: z.enum(['pdf', 'png']).default('pdf'), folderId: z.uuid().optional(),
    /** PNG only: the image's size in CSS pixels and its device pixel ratio. */
    width: z.int().min(64).max(8192).optional(), height: z.int().min(64).max(8192).optional(), scale: z.number().min(1).max(4).optional(),
    /** PNG only: what the browser draws besides the set (a site plan or a 3D model), whose own markings the image carries (D228). */
    drawn: z.strictObject({ planId: z.uuid().optional(), assetModelId: z.uuid().optional() })
      .refine((d) => d.planId === undefined || d.assetModelId === undefined, 'a plan or a model, not both').optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('exported'), file: fileView, placed: z.int(), notPlaced: z.int() }),
    z.object({
      outcome: z.literal('awaiting_image'), job: renderJobView,
      /** What the image prints, with the time it is drawn and the count it does not place: the markings above all. */
      stamp: z.object({ markings: z.array(z.string()), computedAt: z.string(), sources: z.array(z.object({ id: z.uuid(), name: z.string(), age: z.string() })), flags: z.array(z.string()) }),
    }),
    z.object({ outcome: z.literal('refused'), code: z.string(), reason: z.string() }),
  ]),
  status: 201,
});

// ----------------------------------------------------------------------------- image exports (D88, D225)

/** The exporter reads their image export. */
export const getRenderJob = defineContract({
  service: 'canvas-layout', name: 'getRenderJob', method: 'GET', path: '/v1/canvas/render-jobs/:jobId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ jobId: z.uuid() }),
  response: renderJobView,
});

/** The exporter's browser hands back the image: filed as their export, or refused (the markings changed, the image is not one). */
export const completeImageExport = defineContract({
  service: 'canvas-layout', name: 'completeImageExport', method: 'POST', path: '/v1/canvas/render-jobs/:jobId/image', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ jobId: z.uuid() }),
  body: z.strictObject({ content: recordValue(z.base64().max(7_000_000)) }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('exported'), file: fileView, job: renderJobView }),
    z.object({ outcome: z.literal('refused'), code: z.string(), reason: z.string(), job: renderJobView }),
  ]),
  maxBodyBytes: 7_200_000,
});
