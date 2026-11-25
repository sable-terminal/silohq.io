// The AI FDE's endpoints: thin, over services/fde-orchestrator. The person comes from the
// request context; the gateway has checked the route's permission.

import type * as c from '../../contracts/fde-orchestrator/engagement.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Engagements } from '../../services/fde-orchestrator/engagements.service.ts';
import type { Metrics } from '../../services/fde-orchestrator/metrics.service.ts';
import type { Proposals } from '../../services/fde-orchestrator/proposals.service.ts';
import type { Sessions } from '../../services/fde-orchestrator/sessions.service.ts';
import type { Stages } from '../../services/fde-orchestrator/stages.service.ts';
import type { Systems } from '../../services/fde-orchestrator/systems.service.ts';

export interface FdeHandlers {
  start: RouteHandlers<typeof c.startEngagement>;
  list: RouteHandlers<typeof c.listEngagements>;
  get: RouteHandlers<typeof c.getEngagement>;
  pause: RouteHandlers<typeof c.pauseEngagement>;
  resume: RouteHandlers<typeof c.resumeEngagement>;
  stop: RouteHandlers<typeof c.stopEngagement>;
  close: RouteHandlers<typeof c.closeEngagement>;
  limits: RouteHandlers<typeof c.setEngagementLimits>;
  assignEngineer: RouteHandlers<typeof c.assignEngineer>;
  removeEngineer: RouteHandlers<typeof c.removeEngineer>;
  nameOwner: RouteHandlers<typeof c.nameEngagementOwner>;
  confirmExit: RouteHandlers<typeof c.confirmStageExit>;
  tasks: RouteHandlers<typeof c.listTasks>;
  handover: RouteHandlers<typeof c.getHandover>;
  acceptHandover: RouteHandlers<typeof c.acceptHandover>;
  metrics: RouteHandlers<typeof c.getMetrics>;
  proposals: RouteHandlers<typeof c.listProposals>;
  proposal: RouteHandlers<typeof c.getProposal>;
  decide: RouteHandlers<typeof c.decideProposal>;
  acceptGroup: RouteHandlers<typeof c.acceptProposalGroup>;
  assign: RouteHandlers<typeof c.assignProposals>;
  startSession: RouteHandlers<typeof c.startSession>;
  endSession: RouteHandlers<typeof c.endSession>;
  raise: RouteHandlers<typeof c.raiseEscalation>;
  resolve: RouteHandlers<typeof c.resolveEscalation>;
  escalations: RouteHandlers<typeof c.listEscalations>;
  sessions: RouteHandlers<typeof c.listSessions>;
  addSystem: RouteHandlers<typeof c.addEngagementSystem>;
  systems: RouteHandlers<typeof c.listEngagementSystems>;
  withdrawSystem: RouteHandlers<typeof c.withdrawEngagementSystem>;
}

export function fdeController(s: {
  engagements: Engagements; stages: Stages; proposals: Proposals; sessions: Sessions; metrics: Metrics; systems: Systems;
}): FdeHandlers {
  const { engagements, stages, proposals, sessions, metrics, systems } = s;
  return {
    addSystem: { handle: (input, ctx) => systems.add(ctx, input.params.engagementId, input.body) },
    systems: { handle: (input, ctx) => systems.list(ctx, input.params.engagementId) },
    withdrawSystem: { handle: (input, ctx) => systems.withdraw(ctx, input.params.engagementId, input.params.systemId) },
    start: {
      handle: (input, ctx) => engagements.start(ctx, input.body),
      resultRef: (out) => out.id,
      // A retried start answers with the engagement it made, as it stands now.
      replay: async (ref, ctx) => {
        const found = await engagements.get(ctx, ref!);
        return { ...found, stages: found.stages, principals: found.principals };
      },
    },
    list: { handle: (_input, ctx) => engagements.list(ctx) },
    get: { handle: (input, ctx) => engagements.get(ctx, input.params.engagementId) },
    pause: { handle: (input, ctx) => engagements.pause(ctx, input.params.engagementId) },
    resume: { handle: (input, ctx) => engagements.resume(ctx, input.params.engagementId) },
    stop: { handle: (input, ctx) => engagements.stop(ctx, input.params.engagementId, (input.body as { reason: string }).reason) },
    close: { handle: (input, ctx) => engagements.close(ctx, input.params.engagementId) },
    limits: { handle: (input, ctx) => engagements.setLimits(ctx, input.params.engagementId, input.body) },
    assignEngineer: { handle: (input, ctx) => engagements.assignEngineer(ctx, input.params.engagementId, input.body.membershipId) },
    removeEngineer: { handle: (input, ctx) => engagements.removeEngineer(ctx, input.params.engagementId) },
    nameOwner: { handle: (input, ctx) => engagements.nameOwner(ctx, input.params.engagementId, input.body.membershipId) },
    confirmExit: { handle: (input, ctx) => stages.confirmExit(ctx, input.params.engagementId, input.params.stageNumber, input.body.skip) },
    tasks: { handle: (input, ctx) => engagements.tasks(ctx, input.params.engagementId) },
    handover: { handle: (input, ctx) => engagements.handover(ctx, input.params.engagementId) },
    acceptHandover: { handle: (input, ctx) => engagements.acceptHandover(ctx, input.params.engagementId, input.body) },
    metrics: { handle: (input, ctx) => metrics.compute(ctx, input.params.engagementId) },
    proposals: { handle: (input, ctx) => proposals.list(ctx, input.params.engagementId, input.query) },
    proposal: { handle: (input, ctx) => proposals.get(ctx, input.params.proposalId) },
    decide: { handle: (input, ctx) => proposals.decide(ctx, input.params.proposalId, input.body) },
    acceptGroup: { handle: (input, ctx) => proposals.acceptGroup(ctx, input.params.engagementId, input.body) },
    assign: { handle: (input, ctx) => proposals.assign(ctx, input.params.engagementId, input.body) },
    startSession: { handle: (input, ctx) => sessions.start(ctx, input.params.engagementId, input.body) },
    endSession: { handle: (input, ctx) => sessions.end(ctx, input.params.sessionId) },
    raise: { handle: (input, ctx) => sessions.raise(ctx, input.params.engagementId, input.body) },
    resolve: { handle: (input, ctx) => sessions.resolve(ctx, input.params.escalationId, input.body.note) },
    escalations: { handle: (input, ctx) => sessions.list(ctx, input.params.engagementId) },
    sessions: { handle: (input, ctx) => sessions.listSessions(ctx, input.params.engagementId) },
  };
}
