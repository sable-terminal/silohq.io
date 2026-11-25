// Thin handlers: each contract to its function in services/scheduler.

import type {
  acknowledgeEscalation, createCron, deleteCron, getCron, listCronRuns, listCrons, listCronShares, listFiredRuns, pauseCron, resumeCron, revokeCronShare,
  runCronNow, shareCron,
} from '../../contracts/scheduler/cron.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as crons from '../../services/scheduler/crons.service.ts';
import { member, type SchedulerDeps } from '../../services/scheduler/deps.service.ts';
import { runCron } from '../../services/scheduler/runner.service.ts';

export function cronController(deps: SchedulerDeps): {
  createCron: RouteHandlers<typeof createCron>;
  listCrons: RouteHandlers<typeof listCrons>;
  getCron: RouteHandlers<typeof getCron>;
  pauseCron: RouteHandlers<typeof pauseCron>;
  resumeCron: RouteHandlers<typeof resumeCron>;
  deleteCron: RouteHandlers<typeof deleteCron>;
  runCronNow: RouteHandlers<typeof runCronNow>;
  listCronRuns: RouteHandlers<typeof listCronRuns>;
  acknowledgeEscalation: RouteHandlers<typeof acknowledgeEscalation>;
  shareCron: RouteHandlers<typeof shareCron>;
  revokeCronShare: RouteHandlers<typeof revokeCronShare>;
  listCronShares: RouteHandlers<typeof listCronShares>;
  listFiredRuns: RouteHandlers<typeof listFiredRuns>;
} {
  return {
    createCron: {
      handle: ({ body }, ctx) => crons.createCron(deps, ctx, body),
      resultRef: (view) => view.id,
      async replay(ref, ctx) {
        return crons.getCron(deps, ctx, ref!);
      },
    },
    listCrons: { handle: async ({ query }, ctx) => ({ crons: await crons.listCrons(deps, ctx, query.which) }) },
    getCron: { handle: ({ params }, ctx) => crons.getCron(deps, ctx, params.cronId) },
    pauseCron: { handle: ({ params }, ctx) => crons.pauseCron(deps, ctx, params.cronId) },
    resumeCron: { handle: ({ params }, ctx) => crons.resumeCron(deps, ctx, params.cronId) },
    deleteCron: { handle: ({ params }, ctx) => crons.deleteCron(deps, ctx, params.cronId) },
    runCronNow: {
      async handle({ params }, ctx) {
        // The owner or a manager, as for any change; then the run is the Cron's own.
        const view = await crons.getCron(deps, ctx, params.cronId);
        const started = await runCron(deps, member(ctx).organisationId, view.id, 'manual');
        return { runId: started.runId, skipped: started.skipped };
      },
    },
    listCronRuns: { handle: async ({ params, query }, ctx) => ({ runs: await crons.listRuns(deps, ctx, params.cronId, query.limit) }) },
    acknowledgeEscalation: { handle: ({ params }, ctx) => crons.acknowledgeEscalation(deps, ctx, params.runActionId) },
    shareCron: { handle: ({ params, body }, ctx) => crons.shareCron(deps, ctx, params.cronId, body) },
    revokeCronShare: { handle: ({ params }, ctx) => crons.revokeCronShare(deps, ctx, params.cronId, params.shareId) },
    listCronShares: { handle: async ({ params }, ctx) => ({ shares: await crons.listCronShares(deps, ctx, params.cronId) }) },
    listFiredRuns: { handle: ({ body }, ctx) => crons.listFiredRuns(deps, ctx, body) },
  };
}
