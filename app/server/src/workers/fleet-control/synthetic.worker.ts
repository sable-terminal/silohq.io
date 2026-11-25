// The synthetic tests of a release's health gates (services/fleet-control/syntheticTests.service.ts):
// a round at start, then every FLEET_SYNTHETIC_MINUTES, under the release the cell runs. A round
// that cannot run (fleet-control's gateway unreachable, setup refused) is logged and its gates
// stay unreported, so a release waiting on them fails for a missing signal, as it should.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { CellReleases } from '../../services/fleet-control/cellRelease.service.ts';
import type { SyntheticTests } from '../../services/fleet-control/syntheticTests.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function syntheticWorker(options: {
  tests: SyntheticTests; releases: CellReleases; intervalMs: number; logger: Logger;
  /** A round all four passed: a provisioning cell's placement opens (spec 6.3). */
  onPassed?: (correlationId: string) => Promise<unknown>;
}): Worker {
  return {
    name: 'fleet.synthetic',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const state = await options.releases.readState();
          if (state?.phase === 'applied') {
            const correlationId = uuidv7();
            const results = await options.tests.run(state.releaseId, correlationId);
            if (Object.values(results).every(Boolean)) await options.onPassed?.(correlationId);
          }
        } catch (error) {
          options.logger.failure('a round of the synthetic tests could not run', error, { event: 'fleet.synthetic_round_failed' });
        }
        await sleep(options.intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
