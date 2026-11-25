// The cell's agent rollouts moved on every minute (services/connect-runtime/agentUpdates.service.ts):
// a newer release starts its waves, the running one is gated and moves on, and agents are
// judged against the last three minor releases. Every replica runs it; the rollout's row lock
// lets one at a time act. A failed tick is logged and tried again.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { AgentUpdates } from '../../services/connect-runtime/agentUpdates.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function agentRolloutsWorker(options: { updates: AgentUpdates; intervalMs?: number; logger: Logger }): Worker {
  const interval = options.intervalMs ?? 60_000;
  return {
    name: 'connect-runtime.agent-rollouts',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await options.updates.tick();
        } catch (error) {
          options.logger.failure('agent rollouts could not be moved on; trying again', error, { event: 'agent.rollout_tick_failed' });
        }
        await sleep(interval, signal).catch(() => undefined);
      }
    },
  };
}
