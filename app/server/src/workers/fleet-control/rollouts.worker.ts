// Moves running rollouts on every minute, so a wave starts when its turn comes and a
// cell that never reports halts the rollout ("A missing health signal is a failure",
// spec 11.2) without waiting for anyone to ask. A failed tick is logged and retried.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Fleet } from '../../services/fleet-control/fleet.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function rolloutsWorker(options: { fleet: Fleet; intervalMs?: number; logger: Logger }): Worker {
  const interval = options.intervalMs ?? 60_000;
  return {
    name: 'fleet.rollouts',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await options.fleet.tick();
        } catch (error) {
          options.logger.failure('rollouts could not be advanced; trying again', error, { event: 'fleet.tick_failed' });
        }
        await sleep(interval, signal).catch(() => undefined);
      }
    },
  };
}
