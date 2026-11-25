// connector-maintenance's endpoints: parsed input to the re-check and heal services and back.

import {
  SELF_HEAL_QUIET_MINUTES,
  type decideHealProposal, type getHealProposal, type getRecheck, type listHealProposals, type listRechecks, type reportSourceDrift,
  type requestRecheck,
} from '../../contracts/connector-maintenance/maintenance.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Heals } from '../../services/connector-maintenance/heals.service.ts';
import type { Rechecks } from '../../services/connector-maintenance/recheck.service.ts';

export function maintenanceController(rechecks: Rechecks, heals: Heals, background: (work: Promise<unknown>) => void) {
  return {
    requestRecheck: {
      handle: async ({ params }, ctx) => (await rechecks.start(ctx, params.connectionId, 'manual')).view,
      resultRef: (out) => out.id,
      replay: (ref, ctx) => rechecks.get(ctx, ref!),
    } satisfies RouteHandlers<typeof requestRecheck>,
    reportSourceDrift: {
      handle: ({ params }, ctx) => rechecks.selfHeal(ctx, params.connectionId, SELF_HEAL_QUIET_MINUTES),
    } satisfies RouteHandlers<typeof reportSourceDrift>,
    getRecheck: {
      handle: ({ params }, ctx) => rechecks.get(ctx, params.recheckId),
    } satisfies RouteHandlers<typeof getRecheck>,
    listRechecks: {
      handle: async ({ params, query }, ctx) => ({ rechecks: await rechecks.list(ctx, params.connectionId, query.limit) }),
    } satisfies RouteHandlers<typeof listRechecks>,
    listHealProposals: {
      handle: async ({ query }, ctx) => ({ proposals: await heals.list(ctx, query) }),
    } satisfies RouteHandlers<typeof listHealProposals>,
    getHealProposal: {
      handle: ({ params }, ctx) => heals.get(ctx, params.proposalId),
    } satisfies RouteHandlers<typeof getHealProposal>,
    decideHealProposal: {
      handle: ({ params, body }, ctx) => heals.decide(ctx, params.proposalId, body.decision, background),
    } satisfies RouteHandlers<typeof decideHealProposal>,
  };
}
