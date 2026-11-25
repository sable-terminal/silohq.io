// Billing's sweeps (services/billing/sweeps.service.ts): contract renewals and lapses,
// overdue invoices, contract overage and the closed month's Silo charges, at start and then
// every BILLING_SWEEP_SECONDS.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Sweeps } from '../../services/billing/sweeps.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function sweepsWorker(sweeps: Sweeps, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'billing-sweeps',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const counts = await sweeps.run(uuidv7());
          const total = counts.lapsed + counts.upcoming + counts.overdue + counts.overageReported + counts.siloInvoices + counts.seatCounts;
          if (total > 0) logger.info('billing sweep', { event: 'billing.swept', count: total });
        } catch (error) {
          logger.failure('a billing sweep failed', error, { event: 'billing.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
