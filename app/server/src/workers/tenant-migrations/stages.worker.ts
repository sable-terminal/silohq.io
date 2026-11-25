// The tenant migration stage sweep, at start and then every tick.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Stages } from '../../services/tenant-migrations/stages.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function stagesWorker(stages: Stages, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'tenant-migrations',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const result = await stages.tick();
          for (const m of result.moved) {
            logger.info('tenant migration moved a stage', { event: 'tenant_migrations.stage', resourceId: m.migrationId, outcome: m.to, reason: m.from });
          }
        } catch (error) {
          logger.failure('the tenant migration sweep failed', error, { event: 'tenant_migrations.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
