// Keeps the advisory mirror in step (spec 11.1: "SBOMs are checked for vulnerabilities
// daily"): every hour it syncs each feed whose day has come, then checks the live releases
// again (services/fleet-control/vulnerabilities.service.ts). A failed run is logged and
// tried at the next hour; a feed's lease keeps two replicas off one feed.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { SbomChecks } from '../../services/fleet-control/vulnerabilities.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function advisoriesWorker(options: { sbom: SbomChecks; intervalMs?: number; logger: Logger }): Worker {
  const interval = options.intervalMs ?? 3_600_000;
  return {
    name: 'fleet.advisories',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await options.sbom.run(false);
        } catch (error) {
          options.logger.failure('the advisory run failed; trying again in an hour', error, { event: 'fleet.advisories_run_failed' });
        }
        await sleep(interval, signal).catch(() => undefined);
      }
    },
  };
}
