// The cell's Fleet agent applying the cell's releases (services/fleet-control/cellRelease.service.ts):
// at start, then every FLEET_RELEASE_POLL_MINUTES. A pull that fails before anything is applied
// (fleet-control unreachable, a release the cell refuses) is logged and tried again a minute
// later; a failed apply is recorded and reported by the service, and not tried again.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { CellReleases } from '../../services/fleet-control/cellRelease.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function cellReleaseWorker(options: { releases: CellReleases; intervalMs: number; retryMs?: number; logger: Logger }): Worker {
  const retry = Math.min(options.retryMs ?? 60_000, options.intervalMs);
  return {
    name: 'fleet.cell-release',
    async run(signal) {
      while (!signal.aborted) {
        let wait = options.intervalMs;
        try {
          await options.releases.apply(uuidv7());
        } catch (error) {
          options.logger.failure('the cell\'s release could not be pulled; trying again', error, { event: 'fleet.cell_release_pull_failed', outcome: options.releases.channel });
          wait = retry;
        }
        await sleep(wait, signal).catch(() => undefined);
      }
    },
  };
}
