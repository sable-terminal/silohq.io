// discovery's sweep, at start and then every interval: a scan run whose reports stopped (its
// agent, the agent's tunnel or the replica holding it went) is ended as failed, agent_silent.
// connect-runtime reports at least every few seconds while a scan runs (runs.service).

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Runs } from '../../services/discovery/runs.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function silentRunsWorker(runs: Runs, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'discovery-silent-runs',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const ended = await runs.sweep(uuidv7());
          if (ended > 0) logger.info('silent discovery runs ended', { event: 'discovery.runs_silent', count: ended });
        } catch (error) {
          logger.failure('the silent discovery run sweep failed', error, { event: 'discovery.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
