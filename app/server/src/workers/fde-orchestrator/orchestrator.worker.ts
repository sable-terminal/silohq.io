// The AI FDE's orchestrator: every active engagement a step, at start and then every tick.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Orchestrator } from '../../services/fde-orchestrator/orchestrator.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function orchestratorWorker(orchestrator: Orchestrator, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'fde-orchestrator',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await orchestrator.tick();
        } catch (error) {
          logger.failure('the AI FDE sweep failed', error, { event: 'fde.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
