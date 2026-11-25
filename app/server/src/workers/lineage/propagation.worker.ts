// Walks markings added upstream down the lineage graph, round after round (spec 58.6;
// services/lineage/propagation.service.ts). A round that completed something runs again at
// once; otherwise the worker waits its interval.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases } from '../../infra/postgres.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import { propagationRound, type PropagationOptions } from '../../services/lineage/propagation.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function propagationWorker(databases: Databases, logger: Logger, options: PropagationOptions & { intervalMs: number }): Worker {
  return {
    name: 'lineage-marking-propagation',
    async run(signal) {
      while (!signal.aborted) {
        let completed = 0;
        try {
          completed = await propagationRound(databases, logger, options);
        } catch (error) {
          logger.failure('a marking propagation round failed; the next round retries', error, { event: 'lineage.propagation_round_failed' });
        }
        if (completed === 0) await sleep(options.intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
