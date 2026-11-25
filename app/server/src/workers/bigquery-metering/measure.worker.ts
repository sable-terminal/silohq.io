// The metering pass (spec 69.7, 74.1): at each interval (daily by default), every Silo in
// Silo's BigQuery has its completed windows measured and recorded.

import type { Worker } from '../../infra/service.infra.ts';
import { measureAll, type MeteringDeps } from '../../services/bigquery-metering/metering.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function measureWorker(deps: MeteringDeps): Worker {
  return {
    name: 'bigquery-metering',
    async run(signal) {
      while (!signal.aborted) {
        // Shortly after each window closes, so the window's jobs have finished.
        const intervalMs = deps.intervalSeconds * 1_000;
        const wait = intervalMs - (deps.now() % intervalMs) + Math.min(300_000, intervalMs / 10);
        await sleep(wait, signal).catch(() => undefined);
        if (signal.aborted) break;
        await measureAll(deps, uuidv7()).catch((error: unknown) => {
          deps.logger.failure('the BigQuery metering pass failed', error, { event: 'bigquery_metering.pass_failed' });
        });
      }
    },
  };
}
