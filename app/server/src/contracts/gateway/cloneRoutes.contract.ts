// The Clone Canvas in the product (spec 28 to 32): state rules and staleness, layout
// configuration, saved canvas views, the render record, precomputed layouts and the
// Estate map.
//
// A member's own canvas views and preferences need no permission (ownership is the
// authority): those are ownRecords routes and canvas-layout decides access per view, under
// the sharing policy, for the membership the gateway puts in the context. Everything else
// names its permission here and canvas-layout decides again where a type or connection is
// involved (state_rule.manage and ontology.manage on the type).

import * as cv from '../canvas-layout/canvasView.contract.ts';
import * as es from '../canvas-layout/estate.contract.ts';
import * as ly from '../canvas-layout/layout.contract.ts';
import * as sr from '../canvas-layout/stateRule.contract.ts';
import * as sp from '../canvas-layout/spatial.contract.ts';
import * as ci from '../canvas-layout/interaction.contract.ts';
import { definePublicRoute, type PublicRoute } from './publicRoute.contract.ts';

const cloneView = { permission: 'clone.view' };
const manageRules = { permission: 'state_rule.manage' };
const estateView = { permission: 'estate.view' };

// State rules and staleness (28.4, 28.5)
export const proposeStateRule = definePublicRoute({
    name: 'proposeStateRule', method: 'POST', path: '/clones/state-rules', session: 'complete', permission: manageRules,
    body: sr.proposeStateRule.body, response: sr.proposeStateRule.response, status: 201, forwards: sr.proposeStateRule,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const confirmStateRule = definePublicRoute({
    name: 'confirmStateRule', method: 'POST', path: '/clones/state-rules/:ruleId/confirm', session: 'complete', permission: manageRules,
    params: sr.confirmStateRule.params, body: sr.confirmStateRule.body, response: sr.confirmStateRule.response, forwards: sr.confirmStateRule,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const retireStateRule = definePublicRoute({
    name: 'retireStateRule', method: 'POST', path: '/clones/state-rules/:ruleId/retire', session: 'complete', permission: manageRules,
    params: sr.retireStateRule.params, body: sr.retireStateRule.body, response: sr.retireStateRule.response, forwards: sr.retireStateRule,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listStateRules = definePublicRoute({
    name: 'listStateRules', method: 'GET', path: '/clones/state-rules', session: 'complete', permission: cloneView,
    query: sr.listStateRules.query, response: sr.listStateRules.response, forwards: sr.listStateRules,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

export const getActiveStateRules = definePublicRoute({
    name: 'getActiveStateRules', reads: true, method: 'POST', path: '/clones/state-rules/active', session: 'complete', permission: cloneView,
    body: sr.getActiveStateRules.body, response: sr.getActiveStateRules.response, forwards: sr.getActiveStateRules,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

// Time scrubbing and compare (30.8): Capture history only; siloes-capture checks the type, its properties and the Silo's clearance.
/** States for objects an app's canvas or map read (28.4, 35.5): clone.view; canvas-layout checks each input's visibility. */
export const evaluateCloneStates = definePublicRoute({
    name: 'evaluateCloneStates', reads: true, method: 'POST', path: '/clones/states', session: 'complete', permission: cloneView,
    body: sr.evaluateCloneStates.body, response: sr.evaluateCloneStates.response, forwards: sr.evaluateCloneStates, maxBodyBytes: 16 * 1024 * 1024,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const getCloneStatesAt = definePublicRoute({
    name: 'getCloneStatesAt', reads: true, method: 'POST', path: '/clones/time', session: 'complete', permission: cloneView,
    body: sr.getCloneStatesAt.body, response: sr.getCloneStatesAt.response, forwards: sr.getCloneStatesAt,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const setStalenessThreshold = definePublicRoute({
    name: 'setStalenessThreshold', method: 'PUT', path: '/clones/staleness/:connectionId', session: 'complete', permission: manageRules,
    params: sr.setStalenessThreshold.params, body: sr.setStalenessThreshold.body, response: sr.setStalenessThreshold.response,
    forwards: sr.setStalenessThreshold, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listStalenessThresholds = definePublicRoute({
    name: 'listStalenessThresholds', method: 'GET', path: '/clones/staleness', session: 'complete', permission: cloneView,
    query: sr.listStalenessThresholds.query, response: sr.listStalenessThresholds.response, forwards: sr.listStalenessThresholds,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

// Layouts (29.2, 29.8) and the render record (31.9)
export const setCloneLayout = definePublicRoute({
    name: 'setCloneLayout', method: 'PUT', path: '/clones/layouts/:objectTypeId', session: 'complete',
    permission: { permission: 'ontology.manage', resource: (input) => ({ type: 'object_type', id: input.params.objectTypeId }) },
    params: ly.setCloneLayout.params, body: ly.setCloneLayout.body, response: ly.setCloneLayout.response, forwards: ly.setCloneLayout,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listCloneLayouts = definePublicRoute({
    name: 'listCloneLayouts', reads: true, method: 'POST', path: '/clones/layouts/query', session: 'complete', permission: cloneView,
    body: ly.listCloneLayouts.body, response: ly.listCloneLayouts.response, forwards: ly.listCloneLayouts,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const precomputeLayout = definePublicRoute({
    name: 'precomputeLayout', method: 'POST', path: '/clones/layouts/precompute', session: 'complete', permission: cloneView,
    body: ly.precomputeLayout.body, response: ly.precomputeLayout.response, forwards: ly.precomputeLayout,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const getPrecomputedLayout = definePublicRoute({
    name: 'getPrecomputedLayout', method: 'GET', path: '/clones/layouts/precomputed/:precomputationId', session: 'complete', permission: cloneView,
    params: ly.getPrecomputedLayout.params, response: ly.getPrecomputedLayout.response, forwards: ly.getPrecomputedLayout,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const recordRenderSelection = definePublicRoute({
    name: 'recordRenderSelection', reads: true, method: 'POST', path: '/render/selections', session: 'complete', ownRecords: true,
    body: ly.recordRenderSelection.body, response: ly.recordRenderSelection.response, status: 201, forwards: ly.recordRenderSelection,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const setViewPreference = definePublicRoute({
    name: 'setViewPreference', method: 'PUT', path: '/render/preferences', session: 'complete', ownRecords: true,
    body: ly.setViewPreference.body, response: ly.setViewPreference.response, forwards: ly.setViewPreference,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const readViewPreference = definePublicRoute({
    name: 'readViewPreference', method: 'GET', path: '/render/preferences', session: 'complete', ownRecords: true,
    query: ly.readViewPreference.query, response: ly.readViewPreference.response, forwards: ly.readViewPreference,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

// Canvas views (29.6, 29.10)
// An export is a file (spec 41): file.export, and the canvas service opens the view as the exporter.
export const exportCanvasView = definePublicRoute({
    name: 'exportCanvasView', method: 'POST', path: '/canvas/views/:canvasViewId/exports', session: 'complete', permission: { permission: 'file.export' },
    params: cv.exportCanvasView.params, body: cv.exportCanvasView.body, response: cv.exportCanvasView.response, status: 201, forwards: cv.exportCanvasView,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// A PNG export (D88, D225): the exporter's own, drawn by their browser and handed back here.
export const completeCanvasImageExport = definePublicRoute({
    name: 'completeCanvasImageExport', method: 'POST', path: '/canvas/render-jobs/:jobId/image', session: 'complete', permission: { permission: 'file.export' },
    params: cv.completeImageExport.params, body: cv.completeImageExport.body, response: cv.completeImageExport.response, forwards: cv.completeImageExport,
    maxBodyBytes: 7_200_000, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const getRenderJob = definePublicRoute({
    name: 'getRenderJob', method: 'GET', path: '/canvas/render-jobs/:jobId', session: 'complete', ownRecords: true,
    params: cv.getRenderJob.params, response: cv.getRenderJob.response, forwards: cv.getRenderJob,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

// Spatial plans, 3D asset models and anchors (29.4, 29.5; D208): asset.upload to register and anchor (canvas-layout
// checks silo.import, the Silo's markings and clearance on the anchored type), silo.purge to purge, clone.view to list.
export const registerSpatialPlan = definePublicRoute({
    name: 'registerSpatialPlan', method: 'POST', path: '/canvas/spatial-plans', session: 'complete', permission: { permission: 'asset.upload' },
    body: sp.registerSpatialPlan.body, response: sp.registerSpatialPlan.response, status: 201, forwards: sp.registerSpatialPlan,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const registerAssetModel = definePublicRoute({
    name: 'registerAssetModel', method: 'POST', path: '/canvas/asset-models', session: 'complete', permission: { permission: 'asset.upload' },
    body: sp.registerAssetModel.body, response: sp.registerAssetModel.response, status: 201, forwards: sp.registerAssetModel,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const setSpatialAnchor = definePublicRoute({
    name: 'setSpatialAnchor', method: 'POST', path: '/canvas/spatial-anchors', session: 'complete', permission: { permission: 'asset.upload' },
    body: sp.setSpatialAnchor.body, response: sp.setSpatialAnchor.response, status: 201, forwards: sp.setSpatialAnchor,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const removeSpatialAnchor = definePublicRoute({
    name: 'removeSpatialAnchor', method: 'POST', path: '/canvas/spatial-anchors/:anchorId/remove', session: 'complete', permission: { permission: 'asset.upload' },
    params: sp.removeSpatialAnchor.params, response: sp.removeSpatialAnchor.response, forwards: sp.removeSpatialAnchor,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const purgeSpatialPlan = definePublicRoute({
    name: 'purgeSpatialPlan', method: 'POST', path: '/canvas/spatial-plans/:planId/purge', session: 'complete', permission: { permission: 'silo.purge' },
    params: sp.purgeSpatialPlan.params, response: sp.purgeSpatialPlan.response, forwards: sp.purgeSpatialPlan,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const purgeAssetModel = definePublicRoute({
    name: 'purgeAssetModel', method: 'POST', path: '/canvas/asset-models/:assetModelId/purge', session: 'complete', permission: { permission: 'silo.purge' },
    params: sp.purgeAssetModel.params, response: sp.purgeAssetModel.response, forwards: sp.purgeAssetModel,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const listSpatialAssets = definePublicRoute({
    name: 'listSpatialAssets', method: 'GET', path: '/canvas/spatial-assets', session: 'complete', permission: cloneView,
    query: sp.listSpatialAssets.query, response: sp.listSpatialAssets.response, forwards: sp.listSpatialAssets,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

// A plan's image, and where the canvas's objects stand on it (29.4): clone.view, and canvas-layout checks the plan's
// markings and the type.
export const readSpatialPlanImage = definePublicRoute({
    name: 'readSpatialPlanImage', method: 'GET', path: '/canvas/spatial-plans/:planId/image', session: 'complete', permission: cloneView,
    params: sp.readSpatialPlanImage.params, response: sp.readSpatialPlanImage.response, forwards: sp.readSpatialPlanImage,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const placeOnSpatialPlan = definePublicRoute({
    name: 'placeOnSpatialPlan', method: 'POST', path: '/canvas/spatial-plans/:planId/placements', session: 'complete', permission: cloneView,
    params: sp.placeOnSpatialPlan.params, body: sp.placeOnSpatialPlan.body, response: sp.placeOnSpatialPlan.response, forwards: sp.placeOnSpatialPlan,
    maxBodyBytes: 16 * 1024 * 1024,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// A model for the 3D asset view, read in parts, and the node each object stands on (29.5; D228): clone.view, and
// canvas-layout checks the model's markings at every part and the type.
export const readAssetModel = definePublicRoute({
    name: 'readAssetModel', method: 'GET', path: '/canvas/asset-models/:assetModelId/model', session: 'complete', permission: cloneView,
    params: sp.readAssetModel.params, query: sp.readAssetModel.query, response: sp.readAssetModel.response, forwards: sp.readAssetModel,
    call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
  });

export const placeOnAssetModel = definePublicRoute({
    name: 'placeOnAssetModel', method: 'POST', path: '/canvas/asset-models/:assetModelId/placements', session: 'complete', permission: cloneView,
    params: sp.placeOnAssetModel.params, body: sp.placeOnAssetModel.body, response: sp.placeOnAssetModel.response, forwards: sp.placeOnAssetModel,
    maxBodyBytes: 16 * 1024 * 1024,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// What the person did on the canvas, reported by the client (28, 31.5, 31.9; D208).
export const recordCanvasInteraction = definePublicRoute({
    name: 'recordCanvasInteraction', reads: true, method: 'POST', path: '/canvas/interactions', session: 'complete', permission: cloneView,
    body: ci.recordCanvasInteraction.body, response: ci.recordCanvasInteraction.response, status: 201, forwards: ci.recordCanvasInteraction,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const saveCanvasView = definePublicRoute({
    name: 'saveCanvasView', method: 'POST', path: '/canvas/views', session: 'complete', permission: { permission: 'canvas.save' },
    body: cv.saveCanvasView.body, response: cv.saveCanvasView.response, status: 201, forwards: cv.saveCanvasView,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const listCanvasViews = definePublicRoute({
    name: 'listCanvasViews', method: 'GET', path: '/canvas/views', session: 'complete', ownRecords: true,
    query: cv.listCanvasViews.query, response: cv.listCanvasViews.response, forwards: cv.listCanvasViews,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

export const openCanvasView = definePublicRoute({
    name: 'openCanvasView', method: 'GET', path: '/canvas/views/:canvasViewId', session: 'complete', ownRecords: true,
    params: cv.openCanvasView.params, response: cv.openCanvasView.response, forwards: cv.openCanvasView,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const updateCanvasView = definePublicRoute({
    name: 'updateCanvasView', method: 'PUT', path: '/canvas/views/:canvasViewId', session: 'complete', ownRecords: true,
    params: cv.updateCanvasView.params, body: cv.updateCanvasView.body, response: cv.updateCanvasView.response, forwards: cv.updateCanvasView,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const archiveCanvasView = definePublicRoute({
    name: 'archiveCanvasView', method: 'POST', path: '/canvas/views/:canvasViewId/archive', session: 'complete', ownRecords: true,
    params: cv.archiveCanvasView.params, response: cv.archiveCanvasView.response, forwards: cv.archiveCanvasView,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const favouriteCanvasView = definePublicRoute({
    name: 'favouriteCanvasView', method: 'PUT', path: '/canvas/views/:canvasViewId/favourite', session: 'complete', ownRecords: true,
    params: cv.favouriteCanvasView.params, body: cv.favouriteCanvasView.body, response: cv.favouriteCanvasView.response,
    forwards: cv.favouriteCanvasView, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const unfavouriteCanvasView = definePublicRoute({
    name: 'unfavouriteCanvasView', method: 'DELETE', path: '/canvas/views/:canvasViewId/favourite', session: 'complete', ownRecords: true,
    params: cv.unfavouriteCanvasView.params, response: cv.unfavouriteCanvasView.response, forwards: cv.unfavouriteCanvasView,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const shareCanvasView = definePublicRoute({
    name: 'shareCanvasView', method: 'PUT', path: '/canvas/views/:canvasViewId/shares', session: 'complete', permission: { permission: 'canvas.share' },
    params: cv.shareCanvasView.params, body: cv.shareCanvasView.body, response: cv.shareCanvasView.response, forwards: cv.shareCanvasView,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const revokeCanvasViewShare = definePublicRoute({
    name: 'revokeCanvasViewShare', method: 'POST', path: '/canvas/views/:canvasViewId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
    params: cv.revokeCanvasViewShare.params, response: cv.revokeCanvasViewShare.response, forwards: cv.revokeCanvasViewShare,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const listCanvasViewShares = definePublicRoute({
    name: 'listCanvasViewShares', method: 'GET', path: '/canvas/views/:canvasViewId/shares', session: 'complete', ownRecords: true,
    params: cv.listCanvasViewShares.params, response: cv.listCanvasViewShares.response, forwards: cv.listCanvasViewShares,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

// The Estate map (32)
export const getEstateMap = definePublicRoute({
    name: 'getEstateMap', method: 'GET', path: '/estate/map', session: 'complete', permission: estateView,
    response: es.getEstateMap.response, forwards: es.getEstateMap, call: () => ({}), reply: (output) => output,
  });

export const takeEstateSnapshot = definePublicRoute({
    name: 'takeEstateSnapshot', method: 'POST', path: '/estate/snapshots', session: 'complete', permission: estateView,
    body: es.takeEstateSnapshot.body, response: es.takeEstateSnapshot.response, status: 201, forwards: es.takeEstateSnapshot,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const listEstateSnapshots = definePublicRoute({
    name: 'listEstateSnapshots', method: 'GET', path: '/estate/snapshots', session: 'complete', permission: estateView,
    query: es.listEstateSnapshots.query, response: es.listEstateSnapshots.response, forwards: es.listEstateSnapshots,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

export const compareEstateSnapshots = definePublicRoute({
    name: 'compareEstateSnapshots', method: 'GET', path: '/estate/snapshots/compare', session: 'complete', permission: estateView,
    query: es.compareEstateSnapshots.query, response: es.compareEstateSnapshots.response, forwards: es.compareEstateSnapshots,
    call: (input) => ({ query: input.query }), reply: (output) => output,
  });

export const CLONE_ROUTES: readonly PublicRoute[] = [
  proposeStateRule,
  confirmStateRule,
  retireStateRule,
  listStateRules,
  getActiveStateRules,
  getCloneStatesAt,
  evaluateCloneStates,
  setStalenessThreshold,
  listStalenessThresholds,
  setCloneLayout,
  listCloneLayouts,
  precomputeLayout,
  getPrecomputedLayout,
  recordRenderSelection,
  setViewPreference,
  readViewPreference,
  exportCanvasView,
  completeCanvasImageExport,
  getRenderJob,
  saveCanvasView,
  listCanvasViews,
  openCanvasView,
  updateCanvasView,
  archiveCanvasView,
  favouriteCanvasView,
  unfavouriteCanvasView,
  shareCanvasView,
  revokeCanvasViewShare,
  listCanvasViewShares,
  getEstateMap,
  takeEstateSnapshot,
  listEstateSnapshots,
  compareEstateSnapshots,
  registerSpatialPlan,
  registerAssetModel,
  setSpatialAnchor,
  removeSpatialAnchor,
  purgeSpatialPlan,
  purgeAssetModel,
  listSpatialAssets,
  readSpatialPlanImage,
  placeOnSpatialPlan,
  readAssetModel,
  placeOnAssetModel,
  recordCanvasInteraction,
];
