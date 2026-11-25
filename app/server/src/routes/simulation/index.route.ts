// simulation (spec 39): the second engine. A customer-confirmed dependency graph, failure
// scenarios walked deterministically over it, and runs charged against the simulation
// allowance. It states reach through confirmed edges, never cause, and stops at every
// unconfirmed edge rather than routing around it.

import {
  confirmEdge, deriveEdges, listEdges, observeLeadTimes, proposeEdge, retireEdge, reviseEdge,
} from '../../contracts/simulation/graph.contract.ts';
import {
  compareRuns, getLatestSimulationRun, listSimulationRuns, getScenario, getSimulationRun, listObjectScenarios, listScenarios, runScenario, saveScenario, copyScenario, listScenarioShares, revokeScenarioShare, shareScenario } from '../../contracts/simulation/scenario.contract.ts';
import {
  closeBranch, compareBranch, createBranch, getBranch, listBranches, openBranch, promoteBranch, resolveStagedConflicts, restageAction, stageAction,
} from '../../contracts/simulation/branch.contract.ts';
import { simulationController } from '../../controllers/simulation/simulation.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'simulation',
  // redis-data: the idempotency keys of runs, so a retry is charged once.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = simulationController({ databases: deps.databases, services: deps.services, logger: deps.logger });
    return {
      routes: [
        route(deriveEdges, c.deriveEdges), route(proposeEdge, c.proposeEdge), route(listEdges, c.listEdges), route(confirmEdge, c.confirmEdge), route(observeLeadTimes, c.observeLeadTimes),
        route(reviseEdge, c.reviseEdge), route(retireEdge, c.retireEdge),
        route(saveScenario, c.saveScenario), route(listScenarios, c.listScenarios), route(listObjectScenarios, c.listObjectScenarios), route(getScenario, c.getScenario), route(shareScenario, c.shareScenario),
        route(revokeScenarioShare, c.revokeScenarioShare), route(listScenarioShares, c.listScenarioShares), route(copyScenario, c.copyScenario),
        route(runScenario, c.runScenario), route(getSimulationRun, c.getSimulationRun), route(getLatestSimulationRun, c.getLatestSimulationRun), route(listSimulationRuns, c.listSimulationRuns), route(compareRuns, c.compareRuns),
        route(createBranch, c.createBranch), route(listBranches, c.listBranches), route(getBranch, c.getBranch), route(stageAction, c.stageAction),
        route(restageAction, c.restageAction), route(resolveStagedConflicts, c.resolveStagedConflicts), route(openBranch, c.openBranch),
        route(compareBranch, c.compareBranch), route(promoteBranch, c.promoteBranch), route(closeBranch, c.closeBranch),
      ],
    };
  },
});
