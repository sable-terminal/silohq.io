// siloes-capture's background work: writing the capture queue (every few seconds), advancing
// approved purges, the daily retention sweep, and Capture metering at each window.

import type { Worker } from '../../infra/service.infra.ts';
import { drainAll } from '../../services/siloes-capture/capture.service.ts';
import { meterCapture } from '../../services/siloes-capture/metering.service.ts';
import { advancePurges, type PurgeDeps } from '../../services/siloes-capture/purge.service.ts';
import { sweepAll } from '../../services/siloes-capture/retention.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

function every(name: string, seconds: number, work: () => Promise<unknown>, onError: (error: unknown) => void): Worker {
  return {
    name,
    async run(signal) {
      while (!signal.aborted) {
        await sleep(seconds * 1_000, signal).catch(() => undefined);
        if (signal.aborted) break;
        await work().catch(onError);
      }
    },
  };
}

export function siloesWorkers(deps: PurgeDeps, timing: {
  drainSeconds: number; purgeSeconds: number; sweepSeconds: number; meteringSeconds: number; pricePerGibMonth: string;
}): Worker[] {
  const failed = (event: string) => (error: unknown) => deps.logger.failure('a Siloes pass failed', error, { event });
  return [
    every('capture-drain', timing.drainSeconds, () => drainAll(deps, uuidv7()), failed('siloes.drain_failed')),
    every('purge-advance', timing.purgeSeconds, () => advancePurges(deps, uuidv7()), failed('siloes.purge_pass_failed')),
    every('retention-sweep', timing.sweepSeconds, () => sweepAll(deps, uuidv7()), failed('siloes.sweep_failed')),
    every('capture-metering', timing.meteringSeconds, () => meterCapture({ ...deps, intervalSeconds: timing.meteringSeconds,
      pricePerGibMonth: timing.pricePerGibMonth }, uuidv7()), failed('siloes.metering_failed')),
  ];
}
