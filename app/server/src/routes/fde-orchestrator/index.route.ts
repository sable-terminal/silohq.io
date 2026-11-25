// fde-orchestrator (spec 49 to 54; docs/siloServiceCatalogue.doc.md): the AI FDE. Runs
// engagements, agent tasks and proposal queues, and stops at human checkpoints. A client of
// Silo, never part of its execution path: it calls the same services a person calls, as one
// service principal per role, under the same policy decisions.

import * as c from '../../contracts/fde-orchestrator/engagement.contract.ts';
import { fdeController } from '../../controllers/fde-orchestrator/fde.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import type { FdeDeps } from '../../services/fde-orchestrator/deps.service.ts';
import { createEngagements } from '../../services/fde-orchestrator/engagements.service.ts';
import { createMetrics } from '../../services/fde-orchestrator/metrics.service.ts';
import { createOrchestrator } from '../../services/fde-orchestrator/orchestrator.service.ts';
import { createProposals } from '../../services/fde-orchestrator/proposals.service.ts';
import { createSessions } from '../../services/fde-orchestrator/sessions.service.ts';
import { createStages } from '../../services/fde-orchestrator/stages.service.ts';
import { createSystems } from '../../services/fde-orchestrator/systems.service.ts';
import { orchestratorWorker } from '../../workers/fde-orchestrator/orchestrator.worker.ts';

export function createFdeOrchestratorService(options: { now?: () => Date; schedule?: boolean } = {}): ServiceDefinition {
  return defineService({
    name: 'fde-orchestrator',
    // redis-data: the idempotency keys of a keyed start.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const shared: FdeDeps = {
        databases: deps.databases, services: deps.services, logger: deps.logger, cellId: deps.config.cell.id,
        providerPrice: deps.config.fde.providerPrice, ...(options.now ? { now: options.now } : {}),
      };
      const h = fdeController({
        engagements: createEngagements(shared), stages: createStages(shared), proposals: createProposals(shared),
        sessions: createSessions(shared), metrics: createMetrics(shared), systems: createSystems(shared),
      });
      return {
        routes: [
          route(c.startEngagement, h.start), route(c.listEngagements, h.list), route(c.getEngagement, h.get),
          route(c.pauseEngagement, h.pause), route(c.resumeEngagement, h.resume), route(c.stopEngagement, h.stop), route(c.closeEngagement, h.close),
          route(c.setEngagementLimits, h.limits), route(c.assignEngineer, h.assignEngineer), route(c.removeEngineer, h.removeEngineer),
          route(c.nameEngagementOwner, h.nameOwner),
          route(c.confirmStageExit, h.confirmExit), route(c.listTasks, h.tasks), route(c.getHandover, h.handover), route(c.acceptHandover, h.acceptHandover),
          route(c.getMetrics, h.metrics), route(c.listProposals, h.proposals), route(c.getProposal, h.proposal), route(c.decideProposal, h.decide),
          route(c.acceptProposalGroup, h.acceptGroup), route(c.assignProposals, h.assign), route(c.startSession, h.startSession),
          route(c.endSession, h.endSession), route(c.raiseEscalation, h.raise), route(c.resolveEscalation, h.resolve), route(c.listEscalations, h.escalations),
          route(c.listSessions, h.sessions),
          route(c.addEngagementSystem, h.addSystem), route(c.listEngagementSystems, h.systems), route(c.withdrawEngagementSystem, h.withdrawSystem),
        ],
        workers: options.schedule === false ? [] : [orchestratorWorker(createOrchestrator(shared), deps.config.fde.tickSeconds * 1000, deps.logger)],
      };
    },
  });
}

export const service: ServiceDefinition = createFdeOrchestratorService();
