// The cell's Fleet agent pulling its agent channel (services/fleet-control/cellAgent.service.ts):
// at start, then every FLEET_AGENT_POLL_MINUTES. A failed pull is logged and tried again a
// minute later, so a release reaches the cell soon after fleet-control is reachable again.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { CellFleetAgent } from '../../services/fleet-control/cellAgent.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function agentChannelWorker(options: { agent: CellFleetAgent; intervalMs: number; retryMs?: number; logger: Logger }): Worker {
  const retry = Math.min(options.retryMs ?? 60_000, options.intervalMs);
  return {
    name: 'fleet.agent-channel',
    async run(signal) {
      while (!signal.aborted) {
        let wait = options.intervalMs;
        try {
          await options.agent.pull(uuidv7());
        } catch (error) {
          options.logger.failure('the agent channel could not be pulled; trying again', error, { event: 'fleet.agent_channel_failed', outcome: options.agent.channel });
          wait = retry;
        }
        await sleep(wait, signal).catch(() => undefined);
      }
    },
  };
}
