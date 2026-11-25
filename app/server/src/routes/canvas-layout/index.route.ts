// canvas-layout (spec 28 to 32): the server side of the Clone Canvas. State rules and
// staleness thresholds, per-type layout configuration, saved canvas views (opened under the
// opener's own access, shared within the sharing policy, favourited onto the dashboard),
// the render layer's record of what it chose, precomputed layouts for sets above the
// client threshold (held in the state plane only), and the Estate map with its snapshots.
// The browser renders; nothing here stores a value.

import { replaySpatialPurges } from '../../contracts/platform/purgeLedger.contract.ts';
import { replaySpatial } from '../../services/canvas-layout/spatial.service.ts';
import {
  archiveCanvasView, completeImageExport, exportCanvasView, favouriteCanvasView, getRenderJob, listCanvasViewShares,
  listCanvasViews, openCanvasView, revokeCanvasViewShare, saveCanvasView, shareCanvasView, unfavouriteCanvasView, updateCanvasView,
} from '../../contracts/canvas-layout/canvasView.contract.ts';
import { compareEstateSnapshots, getEstateMap, listEstateSnapshots, takeEstateSnapshot } from '../../contracts/canvas-layout/estate.contract.ts';
import {
  getPrecomputedLayout, listCloneLayouts, precomputeLayout, readViewPreference, recordRenderSelection, setCloneLayout, setViewPreference,
} from '../../contracts/canvas-layout/layout.contract.ts';
import {
  confirmStateRule, evaluateCloneStates, getActiveStateRules, getCloneStatesAt, listStalenessThresholds, listStateRules, proposeStateRule, retireStateRule, setStalenessThreshold,
} from '../../contracts/canvas-layout/stateRule.contract.ts';
import {
  listSpatialAssets, placeOnAssetModel, placeOnSpatialPlan, purgeAssetModel, readAssetModel, purgeSpatialPlan, readSpatialPlanImage, registerAssetModel, registerSpatialPlan, removeSpatialAnchor, setSpatialAnchor,
} from '../../contracts/canvas-layout/spatial.contract.ts';
import { recordCanvasInteraction } from '../../contracts/canvas-layout/interaction.contract.ts';
import { canvasLayoutController } from '../../controllers/canvas-layout/canvasLayout.controller.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export function createCanvasLayoutService(options: { store?: ObjectStore } = {}) {
  return defineService({
  name: 'canvas-layout',
  // redis-data: idempotency keys of the keyed operations. redis-state: precomputed positions.
  needs: { postgres: ['control'], redis: ['data', 'state'] },
  async create(deps) {
    // The Silo store: plans and models are read from their Silo files, and a model's checked copy kept beside them (D208).
    const storage = deps.config.objectStorage;
    const store = options.store ?? (storage?.siloesBucket === undefined ? undefined : await createObjectStore(storage));
    const spatialDeps = { databases: deps.databases, services: deps.services, state: deps.redis.state!, logger: deps.logger, store };
    const c = canvasLayoutController(spatialDeps);
    return {
      routes: [
        // After a restore, before traffic (8.2, 12.5; D251).
        route(replaySpatialPurges, { handle: (input) => replaySpatial(spatialDeps, input.body.entries) }),
        route(proposeStateRule, c.proposeStateRule), route(confirmStateRule, c.confirmStateRule), route(retireStateRule, c.retireStateRule),
        route(listStateRules, c.listStateRules), route(getActiveStateRules, c.getActiveStateRules), route(getCloneStatesAt, c.getCloneStatesAt), route(evaluateCloneStates, c.evaluateCloneStates),
        route(setStalenessThreshold, c.setStalenessThreshold), route(listStalenessThresholds, c.listStalenessThresholds),
        route(setCloneLayout, c.setCloneLayout), route(listCloneLayouts, c.listCloneLayouts),
        route(recordRenderSelection, c.recordRenderSelection), route(setViewPreference, c.setViewPreference), route(readViewPreference, c.readViewPreference),
        route(precomputeLayout, c.precomputeLayout), route(getPrecomputedLayout, c.getPrecomputedLayout),
        route(saveCanvasView, c.saveCanvasView), route(updateCanvasView, c.updateCanvasView), route(listCanvasViews, c.listCanvasViews),
        route(exportCanvasView, c.exportCanvasView), route(getRenderJob, c.getRenderJob), route(completeImageExport, c.completeImageExport),
        route(openCanvasView, c.openCanvasView), route(archiveCanvasView, c.archiveCanvasView),
        route(favouriteCanvasView, c.favouriteCanvasView), route(unfavouriteCanvasView, c.unfavouriteCanvasView),
        route(shareCanvasView, c.shareCanvasView), route(revokeCanvasViewShare, c.revokeCanvasViewShare),
        route(listCanvasViewShares, c.listCanvasViewShares),
        route(getEstateMap, c.getEstateMap), route(takeEstateSnapshot, c.takeEstateSnapshot), route(listEstateSnapshots, c.listEstateSnapshots),
        route(compareEstateSnapshots, c.compareEstateSnapshots),
        route(registerSpatialPlan, c.registerSpatialPlan), route(registerAssetModel, c.registerAssetModel), route(setSpatialAnchor, c.setSpatialAnchor),
        route(removeSpatialAnchor, c.removeSpatialAnchor), route(purgeSpatialPlan, c.purgeSpatialPlan), route(purgeAssetModel, c.purgeAssetModel),
        route(listSpatialAssets, c.listSpatialAssets), route(readSpatialPlanImage, c.readSpatialPlanImage), route(placeOnSpatialPlan, c.placeOnSpatialPlan), route(readAssetModel, c.readAssetModel), route(placeOnAssetModel, c.placeOnAssetModel), route(recordCanvasInteraction, c.recordCanvasInteraction),
      ],
    };
  },
  });
}

export const service = createCanvasLayoutService();
