// The AI FDE in the product (spec 49 to 54): engagements, their stages, the confirmation
// queue, sessions and escalations. The gateway's permission is the gate where one
// permission states the rule; where the rule is "this or that" or depends on the proposal,
// the service decides, with the reason written here.

import * as f from '../fde-orchestrator/engagement.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'fde.view' } as const;
const engage = { permission: 'fde.engage' } as const;
const ENGAGE_OR_SUPERVISE = 'fde-orchestrator allows fde.engage, or fde.supervise for a deployment engineer, as spec 49.8 divides them';
const DECIDER = 'fde-orchestrator checks fde.confirm, the permission the proposal kind maps to (52.2) and every marking on the proposal';

const engagementId = (i: { params: { engagementId: string } }) => ({ params: i.params });

export const startEngagement = definePublicRoute({
    name: 'startEngagement', method: 'POST', path: '/fde/engagements', session: 'complete',
    permission: { permission: 'fde.engage', scopeId: (input) => input.body.scopeId },
    body: f.startEngagement.body, response: f.startEngagement.response, status: 201, forwards: f.startEngagement,
    call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const listEngagements = definePublicRoute({
    name: 'listEngagements', method: 'GET', path: '/fde/engagements', session: 'complete', permission: view,
    response: f.listEngagements.response, forwards: f.listEngagements, call: () => ({}), reply: (o) => o,
  });

export const getEngagement = definePublicRoute({
    name: 'getEngagement', method: 'GET', path: '/fde/engagements/:engagementId', session: 'complete', permission: view,
    params: f.getEngagement.params, response: f.getEngagement.response, forwards: f.getEngagement, call: engagementId, reply: (o) => o,
  });

export const pauseEngagement = definePublicRoute({
    name: 'pauseEngagement', method: 'POST', path: '/fde/engagements/:engagementId/pause', session: 'complete', permission: engage,
    params: f.pauseEngagement.params, response: f.pauseEngagement.response, forwards: f.pauseEngagement, call: engagementId, reply: (o) => o,
  });

export const resumeEngagement = definePublicRoute({
    name: 'resumeEngagement', method: 'POST', path: '/fde/engagements/:engagementId/resume', session: 'complete', permission: engage,
    params: f.resumeEngagement.params, response: f.resumeEngagement.response, forwards: f.resumeEngagement, call: engagementId, reply: (o) => o,
  });

export const stopEngagement = definePublicRoute({
    name: 'stopEngagement', method: 'POST', path: '/fde/engagements/:engagementId/stop', session: 'complete', permission: { permission: 'fde.stop' },
    params: f.stopEngagement.params, body: f.stopEngagement.body, response: f.stopEngagement.response, forwards: f.stopEngagement,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const closeEngagement = definePublicRoute({
    name: 'closeEngagement', method: 'POST', path: '/fde/engagements/:engagementId/close', session: 'complete', permission: engage,
    params: f.closeEngagement.params, response: f.closeEngagement.response, forwards: f.closeEngagement, call: engagementId, reply: (o) => o,
  });

export const setEngagementLimits = definePublicRoute({
    name: 'setEngagementLimits', method: 'PATCH', path: '/fde/engagements/:engagementId/limits', session: 'complete', decidedByService: ENGAGE_OR_SUPERVISE,
    params: f.setEngagementLimits.params, body: f.setEngagementLimits.body, response: f.setEngagementLimits.response, forwards: f.setEngagementLimits,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const assignFdeEngineer = definePublicRoute({
    name: 'assignFdeEngineer', method: 'PUT', path: '/fde/engagements/:engagementId/engineer', session: 'complete', permission: engage,
    params: f.assignEngineer.params, body: f.assignEngineer.body, response: f.assignEngineer.response, forwards: f.assignEngineer,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const removeFdeEngineer = definePublicRoute({
    name: 'removeFdeEngineer', method: 'DELETE', path: '/fde/engagements/:engagementId/engineer', session: 'complete', permission: engage,
    params: f.removeEngineer.params, response: f.removeEngineer.response, forwards: f.removeEngineer, call: engagementId, reply: (o) => o,
  });

export const nameFdeEngagementOwner = definePublicRoute({
    name: 'nameFdeEngagementOwner', method: 'PUT', path: '/fde/engagements/:engagementId/owner', session: 'complete', permission: engage,
    params: f.nameEngagementOwner.params, body: f.nameEngagementOwner.body, response: f.nameEngagementOwner.response, forwards: f.nameEngagementOwner,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const confirmStageExit = definePublicRoute({
    name: 'confirmStageExit', method: 'POST', path: '/fde/engagements/:engagementId/stages/:stageNumber/exit', session: 'complete', permission: engage,
    params: f.confirmStageExit.params, body: f.confirmStageExit.body, response: f.confirmStageExit.response, forwards: f.confirmStageExit,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listFdeTasks = definePublicRoute({
    name: 'listFdeTasks', method: 'GET', path: '/fde/engagements/:engagementId/tasks', session: 'complete', permission: view,
    params: f.listTasks.params, response: f.listTasks.response, forwards: f.listTasks, call: engagementId, reply: (o) => o,
  });

export const getHandover = definePublicRoute({
    name: 'getHandover', method: 'GET', path: '/fde/engagements/:engagementId/handover', session: 'complete', permission: view,
    params: f.getHandover.params, response: f.getHandover.response, forwards: f.getHandover, call: engagementId, reply: (o) => o,
  });

export const acceptHandover = definePublicRoute({
    name: 'acceptHandover', method: 'POST', path: '/fde/engagements/:engagementId/handover', session: 'complete', permission: engage,
    params: f.acceptHandover.params, body: f.acceptHandover.body, response: f.acceptHandover.response, forwards: f.acceptHandover,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const getFdeMetrics = definePublicRoute({
    name: 'getFdeMetrics', method: 'GET', path: '/fde/engagements/:engagementId/metrics', session: 'complete', permission: view,
    params: f.getMetrics.params, response: f.getMetrics.response, forwards: f.getMetrics, call: engagementId, reply: (o) => o,
  });

export const listFdeProposals = definePublicRoute({
    name: 'listFdeProposals', method: 'GET', path: '/fde/engagements/:engagementId/proposals', session: 'complete', permission: view,
    params: f.listProposals.params, query: f.listProposals.query, response: f.listProposals.response, forwards: f.listProposals,
    call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
  });

export const getFdeProposal = definePublicRoute({
    name: 'getFdeProposal', method: 'GET', path: '/fde/proposals/:proposalId', session: 'complete', permission: view,
    params: f.getProposal.params, response: f.getProposal.response, forwards: f.getProposal, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const decideFdeProposal = definePublicRoute({
    name: 'decideFdeProposal', method: 'POST', path: '/fde/proposals/:proposalId/decision', session: 'complete', decidedByService: DECIDER,
    params: f.decideProposal.params, body: f.decideProposal.body, response: f.decideProposal.response, forwards: f.decideProposal,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const acceptFdeProposalGroup = definePublicRoute({
    name: 'acceptFdeProposalGroup', method: 'POST', path: '/fde/engagements/:engagementId/group-acceptances', session: 'complete', decidedByService: DECIDER,
    params: f.acceptProposalGroup.params, body: f.acceptProposalGroup.body, response: f.acceptProposalGroup.response, forwards: f.acceptProposalGroup,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const assignFdeProposals = definePublicRoute({
    name: 'assignFdeProposals', method: 'POST', path: '/fde/engagements/:engagementId/assignments', session: 'complete', decidedByService: ENGAGE_OR_SUPERVISE,
    params: f.assignProposals.params, body: f.assignProposals.body, response: f.assignProposals.response, forwards: f.assignProposals,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const startFdeSession = definePublicRoute({
    name: 'startFdeSession', method: 'POST', path: '/fde/engagements/:engagementId/sessions', session: 'complete', decidedByService: ENGAGE_OR_SUPERVISE,
    params: f.startSession.params, body: f.startSession.body, response: f.startSession.response, status: 201, forwards: f.startSession,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const endFdeSession = definePublicRoute({
    name: 'endFdeSession', method: 'POST', path: '/fde/sessions/:sessionId/end', session: 'complete', decidedByService: ENGAGE_OR_SUPERVISE,
    params: f.endSession.params, response: f.endSession.response, forwards: f.endSession, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const raiseFdeEscalation = definePublicRoute({
    name: 'raiseFdeEscalation', method: 'POST', path: '/fde/engagements/:engagementId/escalations', session: 'complete', decidedByService: ENGAGE_OR_SUPERVISE,
    params: f.raiseEscalation.params, body: f.raiseEscalation.body, response: f.raiseEscalation.response, status: 201, forwards: f.raiseEscalation,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const resolveFdeEscalation = definePublicRoute({
    name: 'resolveFdeEscalation', method: 'POST', path: '/fde/escalations/:escalationId/resolution', session: 'complete', decidedByService: ENGAGE_OR_SUPERVISE,
    params: f.resolveEscalation.params, body: f.resolveEscalation.body, response: f.resolveEscalation.response, forwards: f.resolveEscalation,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listFdeEscalations = definePublicRoute({
    name: 'listFdeEscalations', method: 'GET', path: '/fde/engagements/:engagementId/escalations', session: 'complete', permission: view,
    params: f.listEscalations.params, response: f.listEscalations.response, forwards: f.listEscalations, call: engagementId, reply: (o) => o,
  });

export const listFdeSessions = definePublicRoute({
    name: 'listFdeSessions', method: 'GET', path: '/fde/engagements/:engagementId/sessions', session: 'complete', permission: view,
    params: f.listSessions.params, response: f.listSessions.response, forwards: f.listSessions, call: engagementId, reply: (o) => o,
  });

export const addFdeSystem = definePublicRoute({
    name: 'addFdeSystem', method: 'POST', path: '/fde/engagements/:engagementId/systems', session: 'complete', permission: engage,
    params: f.addEngagementSystem.params, body: f.addEngagementSystem.body, response: f.addEngagementSystem.response, status: 201,
    maxBodyBytes: 2 * 1024 * 1024 + 16_384, forwards: f.addEngagementSystem, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listFdeSystems = definePublicRoute({
    name: 'listFdeSystems', method: 'GET', path: '/fde/engagements/:engagementId/systems', session: 'complete', permission: view,
    params: f.listEngagementSystems.params, response: f.listEngagementSystems.response, forwards: f.listEngagementSystems, call: engagementId, reply: (o) => o,
  });

export const withdrawFdeSystem = definePublicRoute({
    name: 'withdrawFdeSystem', method: 'DELETE', path: '/fde/engagements/:engagementId/systems/:systemId', session: 'complete', permission: engage,
    params: f.withdrawEngagementSystem.params, response: f.withdrawEngagementSystem.response, forwards: f.withdrawEngagementSystem,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const FDE_ROUTES = [
  startEngagement,
  listEngagements,
  getEngagement,
  pauseEngagement,
  resumeEngagement,
  stopEngagement,
  closeEngagement,
  setEngagementLimits,
  assignFdeEngineer,
  removeFdeEngineer,
  nameFdeEngagementOwner,
  confirmStageExit,
  listFdeTasks,
  getHandover,
  acceptHandover,
  getFdeMetrics,
  listFdeProposals,
  getFdeProposal,
  decideFdeProposal,
  acceptFdeProposalGroup,
  assignFdeProposals,
  startFdeSession,
  endFdeSession,
  raiseFdeEscalation,
  resolveFdeEscalation,
  listFdeEscalations,
  listFdeSessions,
  addFdeSystem,
  listFdeSystems,
  withdrawFdeSystem,
] as const;
