// The scheduler's watch (spec 40.2): reloads the watching Crons on a timer, keeping their
// interest registered and their subscriptions open, and reporting stream gaps.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Watcher_ } from '../../services/scheduler/watch.service.ts';

export function watchWorker(watcher: Watcher_, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'scheduler-watch',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await watcher.refresh();
        } catch (error) {
          logger.failure('the watch could not reload its Crons; the next round retries', error, { event: 'scheduler.watch_refresh_failed' });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      watcher.close();
    },
  };
}
