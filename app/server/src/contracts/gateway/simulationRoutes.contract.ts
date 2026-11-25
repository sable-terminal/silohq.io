// Simulation in the product (spec 39): proposing and confirming the dependency graph, and
// the member's own failure scenarios, their runs and comparisons. Running a scenario is
// keyed: the gateway passes the member's key through, so a retried run is charged once.

import * as b from '../simulation/branch.contract.ts';
import * as g from '../simulation/graph.contract.ts';
import * as s from '../simulation/scenario.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const propose = { permission: 'graph.propose' };
const confirm = { permission: 'graph.confirm' };

export const deriveSimulationEdges = definePublicRoute({
  name: 'deriveSimulationEdges', method: 'POST', path: '/simulation/edges/derivations', session: 'complete', permission: propose,
  body: g.deriveEdges.body, response: g.deriveEdges.response, forwards: g.deriveEdges, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const proposeSimulationEdge = definePublicRoute({
  name: 'proposeSimulationEdge', method: 'POST', path: '/simulation/edges', session: 'complete', permission: propose,
  body: g.proposeEdge.body, response: g.proposeEdge.response, status: 201, forwards: g.proposeEdge,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listSimulationEdges = definePublicRoute({
  name: 'listSimulationEdges', method: 'GET', path: '/simulation/edges', session: 'complete', permission: { permission: 'ontology.view' },
  query: g.listEdges.query, response: g.listEdges.response, forwards: g.listEdges, call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const confirmSimulationEdge = definePublicRoute({
  name: 'confirmSimulationEdge', method: 'POST', path: '/simulation/edges/:edgeId/confirmation', session: 'complete', permission: confirm,
  params: g.confirmEdge.params, body: g.confirmEdge.body, response: g.confirmEdge.response, forwards: g.confirmEdge,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const reviseSimulationEdge = definePublicRoute({
  name: 'reviseSimulationEdge', method: 'PATCH', path: '/simulation/edges/:edgeId', session: 'complete', permission: confirm,
  params: g.reviseEdge.params, body: g.reviseEdge.body, response: g.reviseEdge.response, forwards: g.reviseEdge,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const retireSimulationEdge = definePublicRoute({
  name: 'retireSimulationEdge', method: 'POST', path: '/simulation/edges/:edgeId/retirement', session: 'complete', permission: confirm,
  params: g.retireEdge.params, body: g.retireEdge.body, response: g.retireEdge.response, forwards: g.retireEdge,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const saveSimulationScenario = definePublicRoute({
  name: 'saveSimulationScenario', method: 'POST', path: '/simulation/scenarios', session: 'complete', permission: { permission: 'simulation.run' },
  body: s.saveScenario.body, response: s.saveScenario.response, status: 201, forwards: s.saveScenario,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listSimulationScenarios = definePublicRoute({
  name: 'listSimulationScenarios', method: 'GET', path: '/simulation/scenarios', session: 'complete', ownRecords: true,
  query: s.listScenarios.query, response: s.listScenarios.response, forwards: s.listScenarios, call: (input) => ({ query: input.query }), reply: (output) => output,
});

// Sharing (39.7): the owner's own scenario, within the organisation's sharing policy, as saved views are.
const sharing = 'simulation shares only its owner\'s scenario, within the sharing policy; a holder copies only under a copy share';

export const shareSimulationScenario = definePublicRoute({
  name: 'shareSimulationScenario', method: 'PUT', path: '/simulation/scenarios/:scenarioId/shares', session: 'complete', decidedByService: sharing,
  params: s.shareScenario.params, body: s.shareScenario.body, response: s.shareScenario.response, forwards: s.shareScenario,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const revokeSimulationScenarioShare = definePublicRoute({
  name: 'revokeSimulationScenarioShare', method: 'POST', path: '/simulation/scenarios/:scenarioId/shares/:shareId/revoke', session: 'complete',
  decidedByService: sharing, params: s.revokeScenarioShare.params, response: s.revokeScenarioShare.response, forwards: s.revokeScenarioShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listSimulationScenarioShares = definePublicRoute({
  name: 'listSimulationScenarioShares', method: 'GET', path: '/simulation/scenarios/:scenarioId/shares', session: 'complete', decidedByService: sharing,
  params: s.listScenarioShares.params, response: s.listScenarioShares.response, forwards: s.listScenarioShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const copySimulationScenario = definePublicRoute({
  name: 'copySimulationScenario', method: 'POST', path: '/simulation/scenarios/:scenarioId/copies', session: 'complete', decidedByService: sharing,
  params: s.copyScenario.params, body: s.copyScenario.body, response: s.copyScenario.response, status: 201, forwards: s.copyScenario,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const readSimulationScenario = definePublicRoute({
  name: 'readSimulationScenario', method: 'GET', path: '/simulation/scenarios/:scenarioId', session: 'complete', ownRecords: true,
  params: s.getScenario.params, response: s.getScenario.response, forwards: s.getScenario, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const runSimulationScenario = definePublicRoute({
  name: 'runSimulationScenario', method: 'POST', path: '/simulation/scenarios/:scenarioId/runs', session: 'complete',
  permission: { permission: 'simulation.run' }, params: s.runScenario.params, response: s.runScenario.response, status: 201, forwards: s.runScenario,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const readSimulationRun = definePublicRoute({
  name: 'readSimulationRun', method: 'GET', path: '/simulation/runs/:runId', session: 'complete', ownRecords: true,
  params: s.getSimulationRun.params, response: s.getSimulationRun.response, forwards: s.getSimulationRun,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** A scenario's latest run as stored, for the canvas overlay (30.9): whoever holds the scenario reads it, never re-run. */
export const readLatestSimulationRun = definePublicRoute({
  name: 'readLatestSimulationRun', method: 'GET', path: '/simulation/scenarios/:scenarioId/runs/latest', session: 'complete', ownRecords: true,
  params: s.getLatestSimulationRun.params, response: s.getLatestSimulationRun.response, forwards: s.getLatestSimulationRun,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** A scenario's own runs, newest first, to choose two to compare (D269). */
export const listSimulationRuns = definePublicRoute({
  name: 'listSimulationRuns', method: 'GET', path: '/simulation/scenarios/:scenarioId/runs', session: 'complete', ownRecords: true,
  params: s.listSimulationRuns.params, query: s.listSimulationRuns.query, response: s.listSimulationRuns.response, forwards: s.listSimulationRuns,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const compareSimulationRuns = definePublicRoute({
  name: 'compareSimulationRuns', method: 'GET', path: '/simulation/scenarios/:scenarioId/comparisons', session: 'complete', ownRecords: true,
  params: s.compareRuns.params, query: s.compareRuns.query, response: s.compareRuns.response, forwards: s.compareRuns,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const observeSimulationLeadTimes = definePublicRoute({
  name: 'observeSimulationLeadTimes', method: 'POST', path: '/simulation/edges/:edgeId/observations', session: 'complete', permission: propose,
  params: g.observeLeadTimes.params, body: g.observeLeadTimes.body, response: g.observeLeadTimes.response, forwards: g.observeLeadTimes,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

const stage = { permission: 'scenario.stage' };

export const createSimulationBranch = definePublicRoute({
  name: 'createSimulationBranch', method: 'POST', path: '/simulation/branches', session: 'complete', permission: stage,
  body: b.createBranch.body, response: b.createBranch.response, status: 201, forwards: b.createBranch, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listSimulationBranches = definePublicRoute({
  name: 'listSimulationBranches', method: 'GET', path: '/simulation/scenarios/:scenarioId/branches', session: 'complete', ownRecords: true,
  params: b.listBranches.params, response: b.listBranches.response, forwards: b.listBranches, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const readSimulationBranch = definePublicRoute({
  name: 'readSimulationBranch', method: 'GET', path: '/simulation/branches/:branchId', session: 'complete', ownRecords: true,
  params: b.getBranch.params, response: b.getBranch.response, forwards: b.getBranch, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const stageSimulationAction = definePublicRoute({
  name: 'stageSimulationAction', method: 'POST', path: '/simulation/branches/:branchId/staged-actions', session: 'complete', permission: stage,
  params: b.stageAction.params, body: b.stageAction.body, response: b.stageAction.response, status: 201, forwards: b.stageAction,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const restageSimulationAction = definePublicRoute({
  name: 'restageSimulationAction', method: 'POST', path: '/simulation/staged-actions/:stagedActionId/restage', session: 'complete', permission: stage,
  params: b.restageAction.params, response: b.restageAction.response, forwards: b.restageAction, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const resolveSimulationConflicts = definePublicRoute({
  name: 'resolveSimulationConflicts', method: 'POST', path: '/simulation/staged-actions/:stagedActionId/resolutions', session: 'complete', permission: stage,
  params: b.resolveStagedConflicts.params, body: b.resolveStagedConflicts.body, response: b.resolveStagedConflicts.response, forwards: b.resolveStagedConflicts,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const openSimulationBranch = definePublicRoute({
  name: 'openSimulationBranch', method: 'POST', path: '/simulation/branches/:branchId/openings', session: 'complete', permission: { permission: 'simulation.run' },
  params: b.openBranch.params, response: b.openBranch.response, status: 201, forwards: b.openBranch, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const compareSimulationBranch = definePublicRoute({
  name: 'compareSimulationBranch', method: 'GET', path: '/simulation/branches/:branchId/comparisons', session: 'complete', ownRecords: true,
  params: b.compareBranch.params, query: b.compareBranch.query, response: b.compareBranch.response, forwards: b.compareBranch,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const promoteSimulationBranch = definePublicRoute({
  name: 'promoteSimulationBranch', method: 'POST', path: '/simulation/branches/:branchId/promotions', session: 'complete', permission: { permission: 'scenario.promote' },
  params: b.promoteBranch.params, body: b.promoteBranch.body, response: b.promoteBranch.response, status: 201, forwards: b.promoteBranch,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const closeSimulationBranch = definePublicRoute({
  name: 'closeSimulationBranch', method: 'POST', path: '/simulation/branches/:branchId/closure', session: 'complete', permission: stage,
  params: b.closeBranch.params, body: b.closeBranch.body, response: b.closeBranch.response, forwards: b.closeBranch,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

/** The object view's scenarios section (34.2): simulation keeps to the scenarios the reader holds. */
export const listObjectSimulationScenarios = definePublicRoute({
  name: 'listObjectSimulationScenarios', reads: true, method: 'POST', path: '/simulation/object-scenarios', session: 'complete', ownRecords: true,
  body: s.listObjectScenarios.body, response: s.listObjectScenarios.response, forwards: s.listObjectScenarios,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const SIMULATION_ROUTES = [
  readLatestSimulationRun,
  listSimulationRuns,
  deriveSimulationEdges, proposeSimulationEdge, observeSimulationLeadTimes, listSimulationEdges, confirmSimulationEdge, reviseSimulationEdge, retireSimulationEdge,
  saveSimulationScenario, listSimulationScenarios, listObjectSimulationScenarios, readSimulationScenario, runSimulationScenario, readSimulationRun, compareSimulationRuns,
  shareSimulationScenario, revokeSimulationScenarioShare, listSimulationScenarioShares, copySimulationScenario,
  createSimulationBranch, listSimulationBranches, readSimulationBranch, stageSimulationAction, restageSimulationAction, resolveSimulationConflicts,
  openSimulationBranch, compareSimulationBranch, promoteSimulationBranch, closeSimulationBranch,
] as const;
