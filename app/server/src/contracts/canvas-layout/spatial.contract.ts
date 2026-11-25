// Spatial plans, 3D asset models and their anchors (spec 29.4, 29.5, 66.4; D208). A plan or
// model is a file imported into an Import Silo (asset_model or site_plan), registered for the
// canvas here by a holder of asset.upload who holds silo.import on its Silo:
//
// - A plan: PNG or JPEG, its size read from the file; SVG and PDF wait for the render
//   service to rasterise them. Georeferenced by three or more control points, or placed by
//   anchors. Its markings are at least its Silo's.
// - A model: a self-contained glTF 2.0 binary of at most 200 MB, its unlisted extensions
//   stripped and named, refused otherwise (asset_model_rejected, and nothing kept).
// - An anchor places one object, or every object a CEL predicate matches, at plan pixels or
//   on a named model node; it needs clearance on the anchored type.
// - Purging a plan or a model (silo.purge), or the Silo file it came from, keeps the row as a
//   record, removes what was served and ends its anchors.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway'] as const;
const id = z.uuid();
const instant = z.string();
const name = z.string().trim().min(1).max(200);

const controlPoint = z.strictObject({
  x: z.number().min(0), y: z.number().min(0), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
});

export const spatialPlanView = z.object({
  id, siloId: id, siloFileId: id, name: z.string(), widthPx: z.int(), heightPx: z.int(),
  controlPoints: z.array(controlPoint).nullable(), markingIds: z.array(id), uploadedBy: id, uploadedAt: instant, purgedAt: instant.nullable(),
});
export type SpatialPlanView = z.infer<typeof spatialPlanView>;

/** A level of a model as it is served (29.5; D249): 0 the full model, then coarser ones. */
export const modelLevel = z.object({ level: z.int().min(0).max(2), bytes: z.int(), triangles: z.int(), ratio: z.number() });

export const assetModelView = z.object({
  id, siloId: id, siloFileId: id, name: z.string(), format: z.literal('gltf2_glb'), bytes: z.string(), nodeNames: z.array(z.string()),
  validationReport: z.record(z.string(), z.json()), markingIds: z.array(id), uploadedBy: id, uploadedAt: instant, purgedAt: instant.nullable(),
  /** The levels it is served at, full first (D249); one for a model registered before them, or one with nothing to simplify. */
  levels: z.array(modelLevel),
  /** Whether this build compressed it (meshopt), it came compressed, or neither. */
  compression: z.enum(['meshopt_applied', 'meshopt_kept', 'draco_kept', 'none']),
});
export type AssetModelView = z.infer<typeof assetModelView>;

export const spatialAnchorView = z.object({
  id, planId: id.nullable(), assetModelId: id.nullable(), objectTypeId: id, objectRef: id.nullable(), matchRule: z.string().nullable(),
  planX: z.number().nullable(), planY: z.number().nullable(), modelNodeName: z.string().nullable(), createdBy: id, createdAt: instant,
});
export type SpatialAnchorView = z.infer<typeof spatialAnchorView>;

export const registerSpatialPlan = defineContract({
  service: 'canvas-layout', name: 'registerSpatialPlan', method: 'POST', path: '/v1/spatial-plans', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    siloFileId: id, name,
    /** Georeferencing: three or more plan pixels with their latitude and longitude. */
    controlPoints: z.array(controlPoint).min(3).max(50).optional(),
    /** Markings beyond the Silo's: a plan carries at least its Silo's. */
    markingIds: z.array(id).max(50).default([]),
  }),
  response: spatialPlanView,
  status: 201,
});

export const registerAssetModel = defineContract({
  service: 'canvas-layout', name: 'registerAssetModel', method: 'POST', path: '/v1/asset-models', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ siloFileId: id, name, markingIds: z.array(id).max(50).default([]) }),
  response: assetModelView,
  status: 201,
  // Checked, compressed and simplified to its levels at upload (29.5; D249): a large model takes a while.
  timeoutMs: 240_000,
});

export const setSpatialAnchor = defineContract({
  service: 'canvas-layout', name: 'setSpatialAnchor', method: 'POST', path: '/v1/spatial-anchors', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    planId: id.optional(), assetModelId: id.optional(), objectTypeId: id,
    /** One object by its Silo identifier, or every object the predicate matches. */
    objectRef: id.optional(), matchRule: z.string().trim().min(1).max(1_000).optional(),
    planX: z.number().min(0).optional(), planY: z.number().min(0).optional(), modelNodeName: z.string().min(1).max(200).optional(),
  }).refine((b) => (b.planId === undefined) !== (b.assetModelId === undefined), 'a plan or a model')
    .refine((b) => (b.objectRef === undefined) !== (b.matchRule === undefined), 'one object or a predicate')
    .refine((b) => (b.planId !== undefined) === (b.planX !== undefined && b.planY !== undefined && b.modelNodeName === undefined)
      && (b.assetModelId !== undefined) === (b.modelNodeName !== undefined && b.planX === undefined && b.planY === undefined), 'plan pixels on a plan, a node on a model'),
  response: spatialAnchorView,
  status: 201,
});

export const removeSpatialAnchor = defineContract({
  service: 'canvas-layout', name: 'removeSpatialAnchor', method: 'POST', path: '/v1/spatial-anchors/:anchorId/remove', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ anchorId: id }),
  response: z.object({ id, removedAt: instant }),
});

export const purgeSpatialPlan = defineContract({
  service: 'canvas-layout', name: 'purgeSpatialPlan', method: 'POST', path: '/v1/spatial-plans/:planId/purge', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ planId: id }),
  response: spatialPlanView,
});

export const purgeAssetModel = defineContract({
  service: 'canvas-layout', name: 'purgeAssetModel', method: 'POST', path: '/v1/asset-models/:assetModelId/purge', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ assetModelId: id }),
  response: assetModelView,
});

export const listSpatialAssets = defineContract({
  service: 'canvas-layout', name: 'listSpatialAssets', method: 'GET', path: '/v1/spatial-assets', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({}),
  response: z.object({
    plans: z.array(spatialPlanView), models: z.array(assetModelView), anchors: z.array(spatialAnchorView),
    /** Plans, models and anchors whose markings or anchored type the reader does not hold. */
    withheld: z.int().min(0),
  }),
});

/**
 * A plan's image for the canvas (29.4): the PNG or JPEG as it was registered, to a reader who
 * holds every marking on the plan; never an SVG or a PDF, which are served only once the
 * render service has rasterised them. A purged plan has no image.
 */
export const readSpatialPlanImage = defineContract({
  service: 'canvas-layout', name: 'readSpatialPlanImage', method: 'GET', path: '/v1/spatial-plans/:planId/image', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ planId: id }),
  response: z.object({
    contentType: z.enum(['image/png', 'image/jpeg']), widthPx: z.int(), heightPx: z.int(), content: recordValue(z.base64()),
  }),
});

export const PLACEMENT_LIMIT = 20_000;

/**
 * Where objects stand on a plan (29.4): an anchor on the object itself first, then the first
 * anchor whose predicate it matches (in the order they were set), then, on a georeferenced
 * plan, its position fitted through the control points. The values are the caller's own
 * reading, used for this answer and never kept; what no rule places is named with why.
 */
export const placeOnSpatialPlan = defineContract({
  service: 'canvas-layout', name: 'placeOnSpatialPlan', method: 'POST', path: '/v1/spatial-plans/:planId/placements', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ planId: id }),
  body: z.strictObject({
    objectTypeId: id,
    objects: z.array(z.strictObject({ ref: id, values: recordValue(z.record(z.string(), z.json())) })).max(PLACEMENT_LIMIT),
    /** On a georeferenced plan: the property holding each object's WGS 84 position. */
    positionProperty: z.string().min(1).max(200).optional(),
  }),
  response: z.object({
    placements: z.array(z.object({ ref: id, x: z.number(), y: z.number(), by: z.enum(['anchor', 'predicate', 'georeference']), anchorId: id.nullable() })),
    notPlaced: z.array(z.object({ ref: id, reason: z.string() })),
  }),
  maxBodyBytes: 16 * 1024 * 1024,
});

/** A part of a model read for the canvas: at most this many bytes. */
export const MODEL_PART_BYTES = 4 * 1024 * 1024;

/**
 * A model for the 3D asset view (29.5; D228), read in parts from the offset asked for, at the
 * level asked for (D249: 0 the full model, then coarser ones): the checked .glb as it was
 * registered, to a reader who holds every marking on the model, each part checked again. A
 * purged model has nothing to read.
 */
export const readAssetModel = defineContract({
  service: 'canvas-layout', name: 'readAssetModel', method: 'GET', path: '/v1/asset-models/:assetModelId/model', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ assetModelId: id }),
  query: z.strictObject({ offset: z.coerce.number().int().min(0).default(0), level: z.coerce.number().int().min(0).max(2).default(0) }),
  response: z.object({ contentType: z.literal('model/gltf-binary'), level: z.int(), bytes: z.int(), offset: z.int(), content: recordValue(z.base64()) }),
});

/**
 * Which node of a model each object stands on (29.5): an anchor on the object itself first,
 * then the first anchor whose predicate it matches (in the order they were set). The values are
 * the caller's own reading, used for this answer and never kept; an object no anchor places
 * carries no state on the model, and is named with why.
 */
export const placeOnAssetModel = defineContract({
  service: 'canvas-layout', name: 'placeOnAssetModel', method: 'POST', path: '/v1/asset-models/:assetModelId/placements', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ assetModelId: id }),
  body: z.strictObject({
    objectTypeId: id,
    objects: z.array(z.strictObject({ ref: id, values: recordValue(z.record(z.string(), z.json())) })).max(PLACEMENT_LIMIT),
  }),
  response: z.object({
    placements: z.array(z.object({ ref: id, node: z.string(), by: z.enum(['anchor', 'predicate']), anchorId: id })),
    notPlaced: z.array(z.object({ ref: id, reason: z.string() })),
  }),
  maxBodyBytes: 16 * 1024 * 1024,
});
