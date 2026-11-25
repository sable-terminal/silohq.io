// The resolution service's endpoints: parsed input to the services and back. Reads through
// the gateway are a person's and need ontology.view (the gateway decided it first; this
// decides again). A keyed operation keeps a reference to its result, so a retry under the
// same key reads what the first produced.

import type {
  declareFieldAuthority, listFieldAuthorities, revokeFieldAuthority,
} from '../../contracts/resolution/authority.contract.ts';
import type {
  confirmResolutionProposal, getResolutionProposal, getResolutionRun, listResolutionProposals, previewResolutionProposal, proposePairs,
  proposeSplit, rejectResolutionProposal, startResolutionRun,
} from '../../contracts/resolution/proposal.contract.ts';
import type { checkSourcePartition, resolveRecords } from '../../contracts/resolution/resolve.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { matchKeyRepo } from '../../repos/ontology/index.repo.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Authorities } from '../../services/resolution/authority.service.ts';
import { demand, type ResolutionDeps } from '../../services/resolution/deps.service.ts';
import type { Proposals } from '../../services/resolution/proposals.service.ts';
import { resolveRecords as resolve } from '../../services/resolution/resolve.service.ts';
import type { Runs } from '../../services/resolution/runs.service.ts';

export function resolutionController(deps: ResolutionDeps, parts: { runs: Runs; proposals: Proposals; authorities: Authorities }) {
  const { runs, proposals, authorities } = parts;
  const viewing = async (ctx: HandlerContext) => {
    if (ctx.caller === 'gateway') await demand(deps, ctx, 'ontology.view');
  };
  return {
    resolveRecords: {
      handle: ({ body }, ctx) => resolve(deps, ctx, body),
    } satisfies RouteHandlers<typeof resolveRecords>,
    checkSourcePartition: {
      handle: async ({ params }, ctx) => ({
        overlapping: await inTransaction(deps.databases.pool('control'), ctx.request, (db) => matchKeyRepo.overlapsSources(db, params.objectTypeId), { readOnly: true }),
      }),
    } satisfies RouteHandlers<typeof checkSourcePartition>,

    startResolutionRun: {
      async handle({ body }, ctx) {
        await demand(deps, ctx, 'ontology.propose', body.objectTypeId);
        return runs.start(ctx, { objectTypeId: body.objectTypeId, analyse: body.analyse });
      },
      resultRef: (out) => out.id,
      replay: (ref, ctx) => runs.get(ctx, ref!),
    } satisfies RouteHandlers<typeof startResolutionRun>,
    getResolutionRun: {
      async handle({ params }, ctx) {
        await viewing(ctx);
        return runs.get(ctx, params.runId);
      },
    } satisfies RouteHandlers<typeof getResolutionRun>,

    listResolutionProposals: {
      async handle({ query }, ctx) {
        await viewing(ctx);
        return { proposals: await proposals.list(ctx, query) };
      },
    } satisfies RouteHandlers<typeof listResolutionProposals>,
    getResolutionProposal: {
      async handle({ params }, ctx) {
        await viewing(ctx);
        return proposals.get(ctx, params.proposalId);
      },
    } satisfies RouteHandlers<typeof getResolutionProposal>,
    previewResolutionProposal: {
      async handle({ params, body }, ctx) {
        await viewing(ctx);
        return proposals.preview(ctx, params.proposalId, body.limit);
      },
    } satisfies RouteHandlers<typeof previewResolutionProposal>,
    proposePairs: {
      handle: ({ body }, ctx) => proposals.proposePairs(ctx, body.objectTypeId, body.pairs),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => proposals.get(ctx, ref!),
    } satisfies RouteHandlers<typeof proposePairs>,
    proposeSplit: {
      handle: ({ body }, ctx) => proposals.proposeSplit(ctx, body.redirectId),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => proposals.get(ctx, ref!),
    } satisfies RouteHandlers<typeof proposeSplit>,
    confirmResolutionProposal: {
      handle: ({ params }, ctx) => proposals.confirm(ctx, params.proposalId),
    } satisfies RouteHandlers<typeof confirmResolutionProposal>,
    rejectResolutionProposal: {
      handle: ({ params }, ctx) => proposals.reject(ctx, params.proposalId),
    } satisfies RouteHandlers<typeof rejectResolutionProposal>,

    declareFieldAuthority: {
      handle: ({ body }, ctx) => authorities.declare(ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => authorities.get(ctx, ref!),
    } satisfies RouteHandlers<typeof declareFieldAuthority>,
    revokeFieldAuthority: {
      handle: ({ params }, ctx) => authorities.revoke(ctx, params.authorityId),
    } satisfies RouteHandlers<typeof revokeFieldAuthority>,
    listFieldAuthorities: {
      async handle({ query }, ctx) {
        await viewing(ctx);
        return { authorities: await authorities.list(ctx, query.objectTypeId, query.includeRevoked === 'true') };
      },
    } satisfies RouteHandlers<typeof listFieldAuthorities>,
  };
}
