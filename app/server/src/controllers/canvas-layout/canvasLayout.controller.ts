// canvas-layout's endpoints: contracts to the services, nothing more.

import { AppError } from '../../utils/errors.util.ts';
import * as renderJobs from '../../services/canvas-layout/renderJobs.service.ts';
import type {
  archiveCanvasView, completeImageExport, exportCanvasView, favouriteCanvasView, getRenderJob, listCanvasViewShares,
  listCanvasViews, openCanvasView, revokeCanvasViewShare, saveCanvasView, shareCanvasView, unfavouriteCanvasView, updateCanvasView,
} from '../../contracts/canvas-layout/canvasView.contract.ts';
import { getExport } from '../../contracts/files/file.contract.ts';
import { exportCanvas } from '../../services/canvas-layout/canvasExport.service.ts';
import type {
  compareEstateSnapshots, getEstateMap, listEstateSnapshots, takeEstateSnapshot,
} from '../../contracts/canvas-layout/estate.contract.ts';
import type {
  getPrecomputedLayout, listCloneLayouts, precomputeLayout, readViewPreference, recordRenderSelection, setCloneLayout, setViewPreference,
} from '../../contracts/canvas-layout/layout.contract.ts';
import type {
  confirmStateRule, evaluateCloneStates, getActiveStateRules, getCloneStatesAt, listStalenessThresholds, listStateRules, proposeStateRule, retireStateRule,
  setStalenessThreshold,
} from '../../contracts/canvas-layout/stateRule.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import * as canvas from '../../services/canvas-layout/canvasViews.service.ts';
import * as layouts from '../../services/canvas-layout/cloneLayouts.service.ts';
import type { CanvasDeps } from '../../services/canvas-layout/deps.service.ts';
import * as estate from '../../services/canvas-layout/estate.service.ts';
import * as precomputed from '../../services/canvas-layout/precompute.service.ts';
import * as render from '../../services/canvas-layout/render.service.ts';
import * as staleness from '../../services/canvas-layout/staleness.service.ts';
import * as rules from '../../services/canvas-layout/stateRules.service.ts';
import { clonesAt } from '../../services/canvas-layout/time.service.ts';
import type {
  listSpatialAssets, placeOnAssetModel, placeOnSpatialPlan, purgeAssetModel, readAssetModel, purgeSpatialPlan, readSpatialPlanImage, registerAssetModel, registerSpatialPlan, removeSpatialAnchor, setSpatialAnchor,
} from '../../contracts/canvas-layout/spatial.contract.ts';
import * as spatial from '../../services/canvas-layout/spatial.service.ts';
import type { recordCanvasInteraction } from '../../contracts/canvas-layout/interaction.contract.ts';
import * as interactions from '../../services/canvas-layout/interaction.service.ts';
import { assetModelRepo, spatialAnchorRepo, spatialPlanRepo } from '../../repos/clone/index.repo.ts';

export function canvasLayoutController(deps: spatial.SpatialDeps) {
  return {
    registerSpatialPlan: {
      handle: (input, ctx) => spatial.registerPlan(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => spatial.planView((await inTransaction(deps.databases.pool('control'), ctx.request, (db) => spatialPlanRepo.findById(db, ref!), { readOnly: true }))!),
    } satisfies RouteHandlers<typeof registerSpatialPlan>,
    registerAssetModel: {
      handle: (input, ctx) => spatial.registerModel(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => spatial.modelView((await inTransaction(deps.databases.pool('control'), ctx.request, (db) => assetModelRepo.findById(db, ref!), { readOnly: true }))!),
    } satisfies RouteHandlers<typeof registerAssetModel>,
    setSpatialAnchor: {
      handle: (input, ctx) => spatial.setAnchor(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => spatial.anchorView((await inTransaction(deps.databases.pool('control'), ctx.request, (db) => spatialAnchorRepo.findById(db, ref!), { readOnly: true }))!),
    } satisfies RouteHandlers<typeof setSpatialAnchor>,
    removeSpatialAnchor: { handle: (input, ctx) => spatial.removeAnchor(deps, ctx, input.params.anchorId) } satisfies RouteHandlers<typeof removeSpatialAnchor>,
    purgeSpatialPlan: { handle: (input, ctx) => spatial.purgePlan(deps, ctx, input.params.planId) } satisfies RouteHandlers<typeof purgeSpatialPlan>,
    purgeAssetModel: { handle: (input, ctx) => spatial.purgeModel(deps, ctx, input.params.assetModelId) } satisfies RouteHandlers<typeof purgeAssetModel>,
    listSpatialAssets: { handle: (_input, ctx) => spatial.listAssets(deps, ctx) } satisfies RouteHandlers<typeof listSpatialAssets>,
    readSpatialPlanImage: { handle: (input, ctx) => spatial.readPlanImage(deps, ctx, input.params.planId) } satisfies RouteHandlers<typeof readSpatialPlanImage>,
    placeOnSpatialPlan: { handle: (input, ctx) => spatial.placeOnPlan(deps, ctx, input.params.planId, input.body) } satisfies RouteHandlers<typeof placeOnSpatialPlan>,
    readAssetModel: { handle: (input, ctx) => spatial.readModelPart(deps, ctx, input.params.assetModelId, input.query.offset, input.query.level) } satisfies RouteHandlers<typeof readAssetModel>,
    placeOnAssetModel: { handle: (input, ctx) => spatial.placeOnModel(deps, ctx, input.params.assetModelId, input.body) } satisfies RouteHandlers<typeof placeOnAssetModel>,
    recordCanvasInteraction: { handle: (input, ctx) => interactions.recordInteraction(deps, ctx, input.body) } satisfies RouteHandlers<typeof recordCanvasInteraction>,
    proposeStateRule: {
      handle: (input, ctx) => rules.propose(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => rules.read(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof proposeStateRule>,
    confirmStateRule: { handle: (input, ctx) => rules.confirm(deps, ctx, input.params.ruleId, input.body.lockVersion) } satisfies RouteHandlers<typeof confirmStateRule>,
    retireStateRule: { handle: (input, ctx) => rules.retire(deps, ctx, input.params.ruleId, input.body.lockVersion) } satisfies RouteHandlers<typeof retireStateRule>,
    listStateRules: { handle: async (input, ctx) => ({ rules: await rules.list(deps, ctx, input.query.objectTypeId) }) } satisfies RouteHandlers<typeof listStateRules>,
    getActiveStateRules: {
      handle: async (input, ctx) => ({ rules: await rules.active(deps, ctx, input.body.objectTypeIds) }),
    } satisfies RouteHandlers<typeof getActiveStateRules>,
    getCloneStatesAt: { handle: (input, ctx) => clonesAt(deps, ctx, input.body) as never } satisfies RouteHandlers<typeof getCloneStatesAt>,
    evaluateCloneStates: { handle: (input, ctx) => rules.evaluateFor(deps, ctx, input.body) } satisfies RouteHandlers<typeof evaluateCloneStates>,
    setStalenessThreshold: {
      handle: (input, ctx) => staleness.set(deps, ctx, input.params.connectionId, input.body),
    } satisfies RouteHandlers<typeof setStalenessThreshold>,
    listStalenessThresholds: {
      handle: async (input, ctx) => ({ thresholds: await staleness.list(deps, ctx, input.query.connectionId) }),
    } satisfies RouteHandlers<typeof listStalenessThresholds>,

    setCloneLayout: { handle: (input, ctx) => layouts.set(deps, ctx, input.params.objectTypeId, input.body) } satisfies RouteHandlers<typeof setCloneLayout>,
    listCloneLayouts: { handle: async (input, ctx) => ({ layouts: await layouts.list(deps, ctx, input.body.objectTypeIds) }) } satisfies RouteHandlers<typeof listCloneLayouts>,
    recordRenderSelection: { handle: (input, ctx) => render.record(deps, ctx, input.body) } satisfies RouteHandlers<typeof recordRenderSelection>,
    setViewPreference: { handle: (input, ctx) => render.setPreference(deps, ctx, input.body) } satisfies RouteHandlers<typeof setViewPreference>,
    readViewPreference: { handle: (input, ctx) => render.readPreference(deps, ctx, input.query) } satisfies RouteHandlers<typeof readViewPreference>,
    precomputeLayout: { handle: (input, ctx) => precomputed.precompute(deps, ctx, input.body) } satisfies RouteHandlers<typeof precomputeLayout>,
    getPrecomputedLayout: {
      handle: (input, ctx) => precomputed.read(deps, ctx, input.params.precomputationId),
    } satisfies RouteHandlers<typeof getPrecomputedLayout>,

    exportCanvasView: {
      handle: (input, ctx) => (input.body.format === 'png'
        ? renderJobs.beginImageExport(deps, ctx, input.params.canvasViewId, input.body)
        : exportCanvas(deps, ctx, input.params.canvasViewId, { format: 'pdf', folderId: input.body.folderId })) as never,
      resultRef: (out) => (out.outcome === 'exported' ? `${out.file.id}.${out.placed}.${out.notPlaced}` : out.outcome === 'awaiting_image' ? `job.${out.job.id}` : ''),
      // A keyed retry: the file the first request made, or the image export it began, as its maker sees it now.
      async replay(ref, ctx) {
        if (ref?.startsWith('job.')) return await renderJobs.awaitingImage(deps, ctx, ref.slice(4)) as never;
        const [fileId, placed, notPlaced] = (ref ?? '').split('.');
        if (!fileId) return { outcome: 'refused' as const, code: 'canvas.export_refused', reason: 'the first request made no file' };
        const file = await deps.services.call(getExport, { params: { fileId } }, { request: ctx.request, correlationId: ctx.correlationId });
        return { outcome: 'exported' as const, file, placed: Number(placed ?? 0), notPlaced: Number(notPlaced ?? 0) };
      },
    } satisfies RouteHandlers<typeof exportCanvasView>,
    getRenderJob: { handle: (input, ctx) => renderJobs.getRenderJob(deps, ctx, input.params.jobId) } satisfies RouteHandlers<typeof getRenderJob>,
    completeImageExport: {
      handle: (input, ctx) => renderJobs.completeImageExport(deps, ctx, input.params.jobId, input.body.content),
    } satisfies RouteHandlers<typeof completeImageExport>,
    saveCanvasView: {
      handle: (input, ctx) => canvas.save(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => canvas.read(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof saveCanvasView>,
    updateCanvasView: { handle: (input, ctx) => canvas.update(deps, ctx, input.params.canvasViewId, input.body) } satisfies RouteHandlers<typeof updateCanvasView>,
    listCanvasViews: {
      handle: async (input, ctx) => ({ views: await canvas.list(deps, ctx, input.query.filter, input.query.limit) }),
    } satisfies RouteHandlers<typeof listCanvasViews>,
    openCanvasView: { handle: (input, ctx) => canvas.open(deps, ctx, input.params.canvasViewId) } satisfies RouteHandlers<typeof openCanvasView>,
    archiveCanvasView: { handle: (input, ctx) => canvas.archive(deps, ctx, input.params.canvasViewId) } satisfies RouteHandlers<typeof archiveCanvasView>,
    favouriteCanvasView: {
      handle: (input, ctx) => canvas.favourite(deps, ctx, input.params.canvasViewId, input.body.grid),
    } satisfies RouteHandlers<typeof favouriteCanvasView>,
    unfavouriteCanvasView: {
      handle: (input, ctx) => canvas.unfavourite(deps, ctx, input.params.canvasViewId),
    } satisfies RouteHandlers<typeof unfavouriteCanvasView>,
    shareCanvasView: { handle: (input, ctx) => canvas.share(deps, ctx, input.params.canvasViewId, input.body) } satisfies RouteHandlers<typeof shareCanvasView>,
    revokeCanvasViewShare: {
      handle: (input, ctx) => canvas.revokeShare(deps, ctx, input.params.canvasViewId, input.params.shareId),
    } satisfies RouteHandlers<typeof revokeCanvasViewShare>,
    listCanvasViewShares: {
      handle: async (input, ctx) => ({ shares: await canvas.listShares(deps, ctx, input.params.canvasViewId) }),
    } satisfies RouteHandlers<typeof listCanvasViewShares>,

    getEstateMap: { handle: (_input, ctx) => estate.open(deps, ctx) } satisfies RouteHandlers<typeof getEstateMap>,
    takeEstateSnapshot: { handle: (input, ctx) => estate.snapshot(deps, ctx, input.body.discoveryRunId) } satisfies RouteHandlers<typeof takeEstateSnapshot>,
    listEstateSnapshots: {
      handle: async (input, ctx) => ({ snapshots: await estate.listSnapshots(deps, ctx, input.query.limit) }),
    } satisfies RouteHandlers<typeof listEstateSnapshots>,
    compareEstateSnapshots: {
      handle: (input, ctx) => estate.compare(deps, ctx, input.query.from, input.query.to),
    } satisfies RouteHandlers<typeof compareEstateSnapshots>,
  };
}
