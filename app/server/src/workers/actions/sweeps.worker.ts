// The actions service's sweeps, at start and then every minute:
// - executions a process started and never finished are recovered by reading the sources,
//   never by writing again (spec 45.3);
// - canaries not confirmed before their chain expires finish as expired, with a receipt for
//   the sample they wrote (45.4).

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Execution } from '../../services/actions/execute.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function executionSweepsWorker(execution: Execution, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'actions-execution-sweeps',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const recovered = await execution.recoverInterrupted(uuidv7());
          if (recovered > 0) logger.info('interrupted executions recovered', { event: 'action.execution_recovered', count: recovered });
          const expired = await execution.expireCanaries(uuidv7());
          if (expired > 0) logger.info('canaries expired', { event: 'action.canary_expired', count: expired });
        } catch (error) {
          logger.failure('an execution sweep failed', error, { event: 'action.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
