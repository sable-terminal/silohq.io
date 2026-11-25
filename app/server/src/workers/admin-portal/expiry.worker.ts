// Break-glass sessions expire on time (spec 13.3: "Maximum 4 hours ... expiry"): every
// running session past its expiry is closed, at start and then every sweep. A session is
// refused for use the moment it expires, whether or not this has run.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { BreakGlass } from '../../services/admin-portal/breakGlass.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function expiryWorker(breakGlass: BreakGlass, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'admin-portal-expiry',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const expired = await breakGlass.sweep(uuidv7());
          if (expired > 0) logger.info('break-glass sessions expired', { event: 'operator_access.expired', count: expired });
        } catch (error) {
          logger.failure('the break-glass expiry sweep failed', error, { event: 'operator_access.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
