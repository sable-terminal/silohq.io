// siloes-import's background work: processing received files, polling watched locations,
// and metering Import files at each window.

import type { Worker } from '../../infra/service.infra.ts';
import type { ImportDeps } from '../../services/siloes-import/import.service.ts';
import { meterImportFiles, pollWatched, processReceived } from '../../services/siloes-import/process.service.ts';
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

export function importWorkers(deps: ImportDeps, timing: { processSeconds: number; meteringSeconds: number; pricePerGibMonth: string }): Worker[] {
  const failed = (event: string) => (error: unknown) => deps.logger.failure('an Import pass failed', error, { event });
  return [
    every('import-process', timing.processSeconds, () => processReceived(deps, uuidv7()), failed('import.process_failed')),
    every('import-watch', timing.processSeconds, () => pollWatched(deps, uuidv7()), failed('import.watch_failed')),
    every('import-metering', timing.meteringSeconds, () => meterImportFiles({ ...deps, intervalSeconds: timing.meteringSeconds,
      pricePerGibMonth: timing.pricePerGibMonth }, uuidv7()), failed('import.metering_failed')),
  ];
}
