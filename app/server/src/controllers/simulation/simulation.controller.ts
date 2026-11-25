// The simulation service's endpoints: contracts to the services that do the work.

import type {
  confirmEdge, deriveEdges, listEdges, observeLeadTimes, proposeEdge, retireEdge, reviseEdge,
} from '../../contracts/simulation/graph.contract.ts';
import type {
  compareRuns, copyScenario, getLatestSimulationRun, listSimulationRuns, getScenario, getSimulationRun, listObjectScenarios, listScenarios, listScenarioShares, revokeScenarioShare, runScenario, saveScenario, shareScenario,
} from '../../contracts/simulation/scenario.contract.ts';
import type {
  closeBranch, compareBranch, createBranch, getBranch, listBranches, openBranch, promoteBranch, resolveStagedConflicts, restageAction, stageAction,
} from '../../contracts/simulation/branch.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as branches from '../../services/simulation/branches.service.ts';
import type { SimulationDeps } from '../../services/simulation/deps.service.ts';
import * as graph from '../../services/simulation/graph.service.ts';
import * as leadTimes from '../../services/simulation/leadTimes.service.ts';
import * as scenarios from '../../services/simulation/scenarios.service.ts';

export function simulationController(deps: SimulationDeps): {
  deriveEdges: RouteHandlers<typeof deriveEdges>;
  observeLeadTimes: RouteHandlers<typeof observeLeadTimes>;
  proposeEdge: RouteHandlers<typeof proposeEdge>;
  listEdges: RouteHandlers<typeof listEdges>;
  confirmEdge: RouteHandlers<typeof confirmEdge>;
  reviseEdge: RouteHandlers<typeof reviseEdge>;
  retireEdge: RouteHandlers<typeof retireEdge>;
  saveScenario: RouteHandlers<typeof saveScenario>;
  listScenarios: RouteHandlers<typeof listScenarios>;
  listObjectScenarios: RouteHandlers<typeof listObjectScenarios>;
  getScenario: RouteHandlers<typeof getScenario>;
  shareScenario: RouteHandlers<typeof shareScenario>;
  revokeScenarioShare: RouteHandlers<typeof revokeScenarioShare>;
  listScenarioShares: RouteHandlers<typeof listScenarioShares>;
  copyScenario: RouteHandlers<typeof copyScenario>;
  runScenario: RouteHandlers<typeof runScenario>;
  getSimulationRun: RouteHandlers<typeof getSimulationRun>;
  getLatestSimulationRun: RouteHandlers<typeof getLatestSimulationRun>;
  listSimulationRuns: RouteHandlers<typeof listSimulationRuns>;
  compareRuns: RouteHandlers<typeof compareRuns>;
  createBranch: RouteHandlers<typeof createBranch>;
  listBranches: RouteHandlers<typeof listBranches>;
  getBranch: RouteHandlers<typeof getBranch>;
  stageAction: RouteHandlers<typeof stageAction>;
  restageAction: RouteHandlers<typeof restageAction>;
  resolveStagedConflicts: RouteHandlers<typeof resolveStagedConflicts>;
  openBranch: RouteHandlers<typeof openBranch>;
  compareBranch: RouteHandlers<typeof compareBranch>;
  promoteBranch: RouteHandlers<typeof promoteBranch>;
  closeBranch: RouteHandlers<typeof closeBranch>;
} {
  return {
    deriveEdges: { handle: (input, ctx) => graph.deriveEdges(deps, ctx, input.body.linkTypeIds) },
    observeLeadTimes: { handle: (input, ctx) => leadTimes.observeLeadTimes(deps, ctx, input.params.edgeId, input.body) },
    proposeEdge: { handle: (input, ctx) => graph.proposeEdge(deps, ctx, input.body) },
    listEdges: { handle: (input, ctx) => graph.listEdges(deps, ctx, input.query.status) },
    confirmEdge: { handle: (input, ctx) => graph.confirmEdge(deps, ctx, input.params.edgeId, input.body) },
    reviseEdge: { handle: (input, ctx) => graph.reviseEdge(deps, ctx, input.params.edgeId, input.body) },
    retireEdge: { handle: (input, ctx) => graph.retireEdge(deps, ctx, input.params.edgeId, input.body) },
    saveScenario: { handle: (input, ctx) => scenarios.saveScenario(deps, ctx, input.body) },
    listScenarios: { handle: async (input, ctx) => ({ scenarios: await scenarios.listScenarios(deps, ctx, input.query.filter) }) },
    listObjectScenarios: { handle: (input, ctx) => scenarios.listObjectScenarios(deps, ctx, input.body) },
    getScenario: { handle: (input, ctx) => scenarios.getScenario(deps, ctx, input.params.scenarioId) },
    shareScenario: { handle: (input, ctx) => scenarios.shareScenario(deps, ctx, input.params.scenarioId, input.body) },
    revokeScenarioShare: { handle: (input, ctx) => scenarios.revokeScenarioShare(deps, ctx, input.params.scenarioId, input.params.shareId) },
    listScenarioShares: { handle: async (input, ctx) => ({ shares: await scenarios.listScenarioShares(deps, ctx, input.params.scenarioId) }) },
    copyScenario: { handle: (input, ctx) => scenarios.copyScenario(deps, ctx, input.params.scenarioId, input.body.name) },
    runScenario: {
      handle: async (input, ctx) => (await scenarios.runScenario(deps, ctx, input.params.scenarioId)).view,
      resultRef: (out) => out.runId,
      // A retried request returns the first run; the charge is not shown again, and was taken once.
      replay: (ref, ctx) => scenarios.readRun(deps, ctx, ref!),
    },
    getSimulationRun: { handle: (input, ctx) => scenarios.readRun(deps, ctx, input.params.runId) },
    getLatestSimulationRun: { handle: (input, ctx) => scenarios.latestRun(deps, ctx, input.params.scenarioId) },
    listSimulationRuns: { handle: (input, ctx) => scenarios.listRuns(deps, ctx, input.params.scenarioId, input.query.limit) },
    compareRuns: { handle: (input, ctx) => scenarios.compareRuns(deps, ctx, input.params.scenarioId, input.query.from, input.query.to) },
    createBranch: { handle: (input, ctx) => branches.createBranch(deps, ctx, input.body) },
    listBranches: { handle: async (input, ctx) => ({ branches: await branches.listBranches(deps, ctx, input.params.scenarioId) }) },
    getBranch: { handle: (input, ctx) => branches.getBranch(deps, ctx, input.params.branchId) },
    stageAction: {
      handle: (input, ctx) => branches.stageAction(deps, ctx, input.params.branchId, input.body),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => (await branches.getBranch(deps, ctx, (await branches.branchOfStaged(deps, ctx, ref!)))).stagedActions.find((s) => s.id === ref)!,
    },
    restageAction: {
      handle: (input, ctx) => branches.restageAction(deps, ctx, input.params.stagedActionId),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => (await branches.getBranch(deps, ctx, (await branches.branchOfStaged(deps, ctx, ref!)))).stagedActions.find((s) => s.id === ref)!,
    },
    resolveStagedConflicts: { handle: (input, ctx) => branches.resolveConflicts(deps, ctx, input.params.stagedActionId, input.body.resolutions) },
    openBranch: {
      handle: async (input, ctx) => (await branches.openBranch(deps, ctx, input.params.branchId)).view,
      resultRef: (out) => out.run.runId,
      // A retry returns the branch and the first run; the charge was taken once.
      replay: (ref, ctx) => branches.replayOpen(deps, ctx, ref!),
    },
    compareBranch: { handle: (input, ctx) => branches.compareBranch(deps, ctx, input.params.branchId, input.query.against) },
    promoteBranch: {
      handle: (input, ctx) => branches.promoteBranch(deps, ctx, input.params.branchId, input.body.stagedActionIds, input.body.canvasViewId),
      resultRef: (out) => out.branch.id,
      replay: (ref, ctx) => branches.replayPromotion(deps, ctx, ref!),
    },
    closeBranch: { handle: (input, ctx) => branches.closeBranch(deps, ctx, input.params.branchId, input.body.version) },
  };
}
