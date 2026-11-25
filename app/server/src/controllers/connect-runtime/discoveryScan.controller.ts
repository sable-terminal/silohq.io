// connect-runtime's discovery scan endpoint: a scan discovery signed, given to the agent
// (spec 10.5; contracts/connect-runtime/discoveryScan.contract.ts).

import type { startDiscoveryScan } from '../../contracts/connect-runtime/discoveryScan.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AgentScans } from '../../services/connect-runtime/agentScans.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function discoveryScanController(scans: () => AgentScans | undefined): RouteHandlers<typeof startDiscoveryScan> {
  return {
    async handle({ params, body }, ctx) {
      const held = scans();
      if (held === undefined) throw new AppError('source_unreachable', 'this replica holds no agent tunnels', { code: 'agent.unavailable', retryable: true });
      return held.start({
        organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, agentId: params.agentId, ...body,
      });
    },
  };
}
