// resolution (spec 23, 24.7, 24.8): entity resolution and field authority. The executor's
// call that resolves rows to Silo objects and merges their values; runs that index a type's
// contributing objects and raise proposals for what did not resolve; proposals a person
// confirms; field authorities a person declares.

import {
  declareFieldAuthority, listFieldAuthorities, revokeFieldAuthority,
} from '../../contracts/resolution/authority.contract.ts';
import {
  confirmResolutionProposal, getResolutionProposal, getResolutionRun, listResolutionProposals, previewResolutionProposal, proposePairs,
  proposeSplit, rejectResolutionProposal, startResolutionRun,
} from '../../contracts/resolution/proposal.contract.ts';
import { checkSourcePartition, resolveRecords } from '../../contracts/resolution/resolve.contract.ts';
import { resolutionController } from '../../controllers/resolution/resolution.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createAuthorities } from '../../services/resolution/authority.service.ts';
import type { ResolutionDeps } from '../../services/resolution/deps.service.ts';
import { createProposals } from '../../services/resolution/proposals.service.ts';
import { createRuns } from '../../services/resolution/runs.service.ts';
import { runsWorker } from '../../workers/resolution/runs.worker.ts';

export const service = defineService({
  name: 'resolution',
  // redis-data: idempotency keys, run status and the per-type run lock.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const resolution: ResolutionDeps = {
      databases: deps.databases, services: deps.services, data: deps.redis.data!, logger: deps.logger,
      maxRowsPerRead: deps.config.executorBounds.maxRowsPerSourceStep,
    };
    const runs = createRuns(resolution);
    const c = resolutionController(resolution, { runs, proposals: createProposals(resolution, runs), authorities: createAuthorities(resolution) });
    return {
      routes: [
        route(resolveRecords, c.resolveRecords), route(checkSourcePartition, c.checkSourcePartition),
        route(startResolutionRun, c.startResolutionRun), route(getResolutionRun, c.getResolutionRun),
        route(listResolutionProposals, c.listResolutionProposals), route(getResolutionProposal, c.getResolutionProposal),
        route(previewResolutionProposal, c.previewResolutionProposal), route(proposePairs, c.proposePairs), route(proposeSplit, c.proposeSplit),
        route(confirmResolutionProposal, c.confirmResolutionProposal), route(rejectResolutionProposal, c.rejectResolutionProposal),
        route(declareFieldAuthority, c.declareFieldAuthority), route(revokeFieldAuthority, c.revokeFieldAuthority),
        route(listFieldAuthorities, c.listFieldAuthorities),
      ],
      workers: [runsWorker(runs)],
    };
  },
});
