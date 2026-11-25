// Receipt purges (spec 46.1, 70): approved purges run as their chains decide, and, where the
// sweep runs, receipts past their retention are purged with the rest of their values.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { ReceiptPurges } from '../../services/actions/receiptPurges.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function receiptPurgesWorker(purges: ReceiptPurges, intervalMs: number, retention: boolean, logger: Logger): Worker {
  return {
    name: 'actions-receipt-purges',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const ran = await purges.advance(uuidv7());
          if (ran > 0) logger.info('receipt purges ran', { event: 'action.receipt_purges_ran', count: ran });
          if (retention) {
            const swept = await purges.sweepAll(uuidv7());
            if (swept > 0) logger.info('receipts past retention purged', { event: 'action.receipts_swept', count: swept });
          }
        } catch (error) {
          logger.failure('a receipt purge pass failed', error, { event: 'action.receipt_purge_pass_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
