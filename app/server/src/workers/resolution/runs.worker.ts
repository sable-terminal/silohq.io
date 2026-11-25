// Resolution runs carry on after the request that started them (services/resolution/
// runs.service.ts). This worker holds the process's runs: on shutdown it stops them at the
// next batch boundary and waits for them, so a run ends as abandoned, never half-written.

import type { Worker } from '../../infra/service.infra.ts';
import type { Runs } from '../../services/resolution/runs.service.ts';

export function runsWorker(runs: Runs): Worker {
  return {
    name: 'resolution-runs',
    async run(signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await runs.drain();
    },
  };
}
