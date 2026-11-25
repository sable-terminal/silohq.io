// connect-runtime's relay endpoint: work for an agent this replica holds, relayed by the
// replica that chose it (spec 10.3; contracts/connect-runtime/agentRelay.contract.ts).

import type { relayAgentWork } from '../../contracts/connect-runtime/agentRelay.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AgentTunnels } from '../../services/connect-runtime/agentTunnels.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function relayController(tunnels: () => AgentTunnels | undefined): RouteHandlers<typeof relayAgentWork> {
  return {
    async handle({ params, body }, ctx) {
      const held = tunnels();
      if (held === undefined) throw new AppError('source_unreachable', 'this replica holds no agent tunnels', { code: 'agent.not_here' });
      const { seal, sealKey, ...work } = body;
      const frames = await held.relayed({
        ...work, organisationId: ctx.request.organisationId!, agentId: params.agentId, signal: ctx.signal,
        ...(seal === undefined ? {} : { seal: { ...seal, request: ctx.request, correlationId: ctx.correlationId } }),
        ...(sealKey === undefined ? {} : { sealKey: { ...sealKey, request: ctx.request, correlationId: ctx.correlationId } }),
      });
      return { frames };
    },
  };
}
