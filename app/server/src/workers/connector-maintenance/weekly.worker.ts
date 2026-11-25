// The weekly re-check (spec 17.3): every interval, the active connections whose last re-check
// is older than a week, across organisations (identifiers only, through a definer function),
// are re-checked as the service, a few at a time. A connection whose re-check is running
// elsewhere is skipped (its lock is held); one that fails is recorded failed and retried on a
// later pass, since a failed re-check does not count as done.

import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import { probeRunRepo } from '../../repos/connect/index.repo.ts';
import type { Rechecks } from '../../services/connector-maintenance/recheck.service.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export interface WeeklySettings {
  /** How often the worker looks for connections due. */
  intervalMs: number;
  /** A connection is due when its last re-check started longer ago than this. */
  dueAfterSeconds: number;
  /** Re-checks in flight at once in this process. */
  concurrency: number;
  /** Connections taken per pass. */
  batch: number;
}

export const WEEKLY_DEFAULTS: WeeklySettings = { intervalMs: 15 * 60_000, dueAfterSeconds: 7 * 86_400, concurrency: 2, batch: 50 };

export function weeklyRecheckWorker(databases: Databases, rechecks: Rechecks, logger: Logger, settings: WeeklySettings): Worker {
  const pool = databases.pool('control');
  return {
    name: 'connector-maintenance-weekly',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const due = await inTransaction(pool, {}, (db) => probeRunRepo.dueForRecheck(db, settings.dueAfterSeconds, settings.batch), { readOnly: true });
          const queue = [...due];
          const lane = async (): Promise<void> => {
            for (let next = queue.shift(); next !== undefined && !signal.aborted; next = queue.shift()) {
              const ctx = { request: { organisationId: next.organisationId }, correlationId: uuidv7() };
              try {
                const { done } = await rechecks.start(ctx, next.connectionId, 'weekly');
                await done;
              } catch (error) {
                if (isAppError(error) && (error.code === 'maintenance.recheck_in_progress' || error.code === 'maintenance.connection_not_checkable')) continue;
                logger.failure('a weekly re-check could not start', error, {
                  event: 'maintenance.weekly_failed', organisationId: next.organisationId, resourceId: next.connectionId,
                });
              }
            }
          };
          await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, lane));
          if (due.length > 0) logger.info('weekly re-checks ran', { event: 'maintenance.weekly_pass', count: due.length });
        } catch (error) {
          logger.failure('the weekly re-check pass failed; the next pass retries', error, { event: 'maintenance.weekly_pass_failed' });
        }
        await sleep(settings.intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
