// Runs requested organisation exports, one sweep at start and then every tick.

import { processLoad } from '../../infra/load.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Exports } from '../../services/org-export/exports.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function exportWorker(exports: Exports, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'org-export',
    async run(signal) {
      while (!signal.aborted) {
        try {
          // Under load, rendering waits for a later tick (12.4); the requests stay queued.
          if (!processLoad().sheds('export_render')) await exports.sweep();
        } catch (error) {
          logger.failure('the organisation export sweep failed', error, { event: 'org_export.sweep_failed' });
        }
        await sleep(intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
