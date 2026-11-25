// Action ledger copies owed (spec 48.2): a copy that failed after its brief retries is sent
// again when due, until written. Like receipt purges, this always runs: a row the ledger is owed
// must reach it.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Execution } from '../../services/actions/execute.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function ledgerCopiesWorker(execution: Execution, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'actions-ledger-copies',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const written = await execution.retryLedgerCopies(uuidv7());
          if (written > 0) logger.info('owed Action ledger copies written', { event: 'action.ledger_copies_written', count: written });
        } catch (error) {
          logger.failure('a ledger copy pass failed', error, { event: 'action.ledger_copy_pass_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
