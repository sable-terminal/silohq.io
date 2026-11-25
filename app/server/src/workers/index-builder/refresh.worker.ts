// Scheduled Object Index refresh (spec 69.4): at each tick, the nominations whose schedule
// has come round are claimed once (their next time moved on) and refreshed, each as its
// Silo's own principal. A tick that finds nothing due does nothing.

import { processLoad } from '../../infra/load.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { IndexDeps } from '../../services/index-builder/index.service.ts';
import { refreshDue } from '../../services/index-builder/refresh.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function refreshWorker(deps: IndexDeps, tickSeconds: number): Worker {
  return {
    name: 'index-scheduled-refresh',
    async run(signal) {
      while (!signal.aborted) {
        await sleep(tickSeconds * 1_000, signal).catch(() => undefined);
        if (signal.aborted) break;
        // Under load, index refreshes wait for a later tick (12.4): nothing is claimed, so nothing is lost.
        if (processLoad().sheds('index_rebuild')) continue;
        await refreshDue(deps, uuidv7()).catch((error: unknown) => {
          deps.logger.failure('the scheduled Object Index pass failed', error, { event: 'index.schedule_failed' });
        });
      }
    },
  };
}
