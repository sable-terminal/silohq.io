// Layouts (spec 29.2, 29.8) and the render layer's record of what it chose (31.4, 31.9).
//
// - Clone layouts: per object type, the properties that drive each canvas layout (a Located
//   property and its CRS, a containment link, stage, time and lane properties, the label).
//   Configuration a person sets against main's ontology; superseded, never edited.
// - Selection lives in the client (31.4: the server keeps no second shape set). What the
//   server keeps is the record: render_selections names the result by reference, its
//   structure as counts and booleans, the choice, the alternatives offered and any
//   override, which is the only measure of whether precedence is right. view_preferences
//   keeps each person's preferred representation per view. Nothing else: never a result.
// - Precomputation (29.8): above the client threshold the server computes positions for a
//   set and holds them in the state plane under TTL (default 24 hours), never on disk; the
//   control plane keeps only the parameters, the set definition's hash and the cache key.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** The canvas layouts, list being the floor that renders any set (29.2). */
export const CANVAS_LAYOUTS = [
  'schematic', 'graph_force', 'graph_layered', 'spatial_map', 'spatial_3d', 'hierarchy', 'timeline', 'list',
] as const;
export type CanvasLayout = (typeof CANVAS_LAYOUTS)[number];

/** The ten archetypes (31.3), closed. */
export const ARCHETYPES = [
  'comparison', 'chain', 'hierarchy', 'network', 'series', 'distribution', 'ranking', 'composition', 'figure', 'table',
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export const cloneLayoutView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  geoPropertyId: z.uuid().nullable(),
  crs: z.string().nullable(),
  containmentLinkTypeId: z.uuid().nullable(),
  stagePropertyId: z.uuid().nullable(),
  timePropertyId: z.uuid().nullable(),
  lanePropertyId: z.uuid().nullable(),
  labelPropertyId: z.uuid(),
  /** Main's sequence the configuration was checked against. */
  ontologyVersion: z.int(),
  createdBy: z.uuid(),
  createdAt: z.string(),
});
export type CloneLayoutView = z.infer<typeof cloneLayoutView>;

export const setCloneLayout = defineContract({
  service: 'canvas-layout', name: 'setCloneLayout', method: 'PUT', path: '/v1/clones/layouts/:objectTypeId', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid() }),
  body: z.strictObject({
    labelPropertyId: z.uuid(),
    geoPropertyId: z.uuid().optional(),
    /** EPSG code, required with geoPropertyId: WGS 84 (EPSG:4326), British National Grid (EPSG:27700), or another declared one. */
    crs: z.string().regex(/^EPSG:[0-9]{4,6}$/).optional(),
    containmentLinkTypeId: z.uuid().optional(),
    stagePropertyId: z.uuid().optional(),
    timePropertyId: z.uuid().optional(),
    lanePropertyId: z.uuid().optional(),
  }).refine((b) => (b.geoPropertyId === undefined) === (b.crs === undefined), 'a Located property names its CRS, and only then'),
  response: cloneLayoutView,
});

export const listCloneLayouts = defineContract({
  service: 'canvas-layout', name: 'listCloneLayouts', method: 'POST', path: '/v1/clones/layouts/query',
  callers: ['gateway', 'studio', 'state-plane'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeIds: z.array(z.uuid()).min(1).max(200) }),
  response: z.object({ layouts: z.array(cloneLayoutView) }),
});

// ----------------------------------------------------------------------------- render record

/** Selection signals (31.4): counts and booleans read from the result's structure. Never a value. */
export const resultStructure = z.strictObject({
  rowCount: z.int().min(0),
  measureCount: z.int().min(0),
  measureFromTwoSources: z.boolean(),
  hasTimeField: z.boolean(),
  orderedByTime: z.boolean(),
  hasEdges: z.boolean(),
  edgesDirected: z.boolean(),
  hasCycle: z.boolean(),
  singleParent: z.boolean(),
  sumsToWhole: z.boolean(),
  deviationComputed: z.boolean(),
  /** Canvas signals (29.2). */
  located: z.boolean().default(false),
  hasPlan: z.boolean().default(false),
  hasModel: z.boolean().default(false),
  notPlaced: z.int().min(0).default(0),
});

export const recordRenderSelection = defineContract({
  service: 'canvas-layout', name: 'recordRenderSelection', method: 'POST', path: '/v1/render/selections',
  callers: ['gateway', 'studio', 'ask', 'workspace'], context: 'organisation', idempotency: 'none',
  body: z.discriminatedUnion('surface', [
    z.strictObject({
      surface: z.literal('view'),
      resultRef: z.uuid(),
      resultStructure,
      chosen: z.enum(ARCHETYPES),
      alternativesOffered: z.array(z.enum(ARCHETYPES)).max(ARCHETYPES.length),
      overriddenTo: z.enum(ARCHETYPES).optional(),
    }),
    z.strictObject({
      surface: z.literal('canvas'),
      resultRef: z.uuid(),
      resultStructure,
      chosen: z.enum(CANVAS_LAYOUTS),
      alternativesOffered: z.array(z.enum(CANVAS_LAYOUTS)).max(CANVAS_LAYOUTS.length),
      overriddenTo: z.enum(CANVAS_LAYOUTS).optional(),
    }),
  ]),
  response: z.object({ id: z.uuid(), recordedAt: z.string(), userOverride: z.boolean() }),
  status: 201,
});

export const REPRESENTATIONS = ['prose', 'view', 'data', 'canvas', 'list'] as const;

export const setViewPreference = defineContract({
  service: 'canvas-layout', name: 'setViewPreference', method: 'PUT', path: '/v1/render/preferences', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.union([
    z.strictObject({ savedViewId: z.uuid(), preferredRepresentation: z.enum(['prose', 'view', 'data']) }),
    z.strictObject({ canvasViewId: z.uuid(), preferredRepresentation: z.enum(['canvas', 'list']) }),
  ]),
  response: z.object({ preferredRepresentation: z.enum(REPRESENTATIONS), updatedAt: z.string() }),
});

/** The reader's own preferred representation of a view they may open (31.2), or null where they have none. */
export const readViewPreference = defineContract({
  service: 'canvas-layout', name: 'readViewPreference', method: 'GET', path: '/v1/render/preferences', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ savedViewId: z.uuid().optional(), canvasViewId: z.uuid().optional() })
    .refine((q) => (q.savedViewId === undefined) !== (q.canvasViewId === undefined), { message: 'name a saved view or a canvas view, exactly one' }),
  response: z.object({ preferredRepresentation: z.enum(REPRESENTATIONS).nullable(), updatedAt: z.string().nullable() }),
});

// ----------------------------------------------------------------------------- precomputation

/** Positions for a set too large for the client (29.8): computed here, held in the state plane only. */
export const precomputeLayout = defineContract({
  service: 'canvas-layout', name: 'precomputeLayout', method: 'POST', path: '/v1/clones/layouts/precompute',
  callers: ['gateway', 'state-plane'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    layout: z.enum(['graph_force', 'graph_layered', 'hierarchy', 'schematic', 'timeline']),
    /** The graph to place: node references and directed edges, never values (the caller resolved the set). */
    setDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/),
    objectSetId: z.uuid(),
    ontologyVersion: z.int().min(1),
    nodes: z.array(z.strictObject({
      ref: z.uuid(),
      /** Lane or time position for timeline layouts, as a number (epoch milliseconds, or a lane index). */
      time: z.number().optional(),
      lane: z.int().min(0).max(1_000).optional(),
    })).min(1).max(100_000),
    edges: z.array(z.tuple([z.int().min(0), z.int().min(0)])).max(500_000),
  }),
  response: z.object({
    id: z.uuid(),
    cacheKey: z.string(),
    nodeCount: z.int(),
    expiresAt: z.string(),
    /** Whether an earlier computation for the same set, layout and ontology version was reused. */
    reused: z.boolean(),
  }),
  maxBodyBytes: 32 * 1024 * 1024,
});

export const getPrecomputedLayout = defineContract({
  service: 'canvas-layout', name: 'getPrecomputedLayout', method: 'GET', path: '/v1/clones/layouts/precomputed/:precomputationId',
  callers: ['gateway', 'state-plane'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ precomputationId: z.uuid() }),
  response: z.object({
    layout: z.enum(CANVAS_LAYOUTS),
    nodeCount: z.int(),
    /** Per node in request order: x, y (null when not placed) and the cluster it falls in at the lowest zoom. */
    positions: z.array(z.tuple([z.number().nullable(), z.number().nullable(), z.int()])),
    notPlaced: z.int(),
    computedAt: z.string(),
    expiresAt: z.string(),
  }),
});
