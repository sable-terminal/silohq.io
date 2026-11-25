// The metering.usage consumer: at least once, so the handler records each measurement once
// by its point key and recomputes model usage from the ledger. A thrown error redelivers
// the message.

import type { DurableBus } from '../../infra/bus.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import { handleUsage } from '../../services/metering/usage.service.ts';
import type { MeteringDeps } from '../../services/metering/deps.service.ts';

export function usageWorker(deps: Pick<MeteringDeps, 'databases' | 'logger'>, bus: DurableBus, consumer: string): Worker {
  return {
    name: 'metering-usage',
    async run(signal) {
      const unsubscribe = await bus.subscribe('metering.usage', consumer, async (message) => {
        const outcome = await handleUsage(deps, message);
        if (outcome === 'recorded') deps.logger.debug('usage recorded', { event: `metering.${message.name}_recorded`, eventId: message.eventId });
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await unsubscribe();
    },
  };
}
