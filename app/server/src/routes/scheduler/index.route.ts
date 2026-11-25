// scheduler (spec 40): Crons. A saved question run on a schedule as the Cron's own service
// principal, a condition over its answer, and the notify, report and escalate actions taken
// when it holds; every run recorded, including those that skipped or did not meet the
// condition.

import {
  acknowledgeEscalation, listCronShares, listFiredRuns, revokeCronShare, shareCron, createCron, deleteCron, getCron, listCronRuns, listCrons, pauseCron, resumeCron, runCronNow,
} from '../../contracts/scheduler/cron.contract.ts';
import { cronController } from '../../controllers/scheduler/cron.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { dueWorker } from '../../workers/scheduler/due.worker.ts';
import { watchWorker } from '../../workers/scheduler/watch.worker.ts';
import { createWatcher, type Watcher_ } from '../../services/scheduler/watch.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface SchedulerOptions {
  now?: () => number;
  sweep?: boolean;
  /** Watch object sets for change triggers (40.2): it needs redis-state and bus-live. The deployed service does. */
  watch?: boolean;
  /** How often the watch reloads the watching Crons. Default 30 seconds. */
  watchRefreshMs?: number;
  onWatcher?: (watcher: Watcher_) => void;
}

export function createSchedulerService(options: SchedulerOptions = {}) {
  return defineService({
    name: 'scheduler',
    // redis-data: idempotency keys of the keyed operations; redis-state and bus-live: the watch.
    needs: options.watch ? { postgres: ['control'], redis: ['data', 'state'], bus: ['live'] } : { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const scheduler = {
        databases: deps.databases, services: deps.services, logger: deps.logger, config: deps.config.scheduler, now: options.now ?? Date.now,
      };
      const c = cronController(scheduler);
      const workers = options.sweep === false ? [] : [dueWorker(scheduler)];
      let watcher: Watcher_ | undefined;
      if (options.watch) {
        if (deps.redis.state === undefined || deps.liveBus === undefined) {
          throw new AppError('configuration', 'the scheduler\'s watch needs redis-state and bus-live', { code: 'config.scheduler.watch' });
        }
        watcher = createWatcher({ ...scheduler, state: deps.redis.state, liveBus: deps.liveBus, cellId: deps.config.cell.id });
        options.onWatcher?.(watcher);
        if (options.sweep !== false) workers.push(watchWorker(watcher, options.watchRefreshMs ?? 30_000, deps.logger));
      }
      return {
        close: async () => watcher?.close(),
        routes: [
          route(createCron, c.createCron), route(listCrons, c.listCrons), route(getCron, c.getCron), route(pauseCron, c.pauseCron),
          route(resumeCron, c.resumeCron), route(deleteCron, c.deleteCron), route(runCronNow, c.runCronNow), route(listCronRuns, c.listCronRuns),
          route(acknowledgeEscalation, c.acknowledgeEscalation), route(shareCron, c.shareCron), route(revokeCronShare, c.revokeCronShare),
          route(listCronShares, c.listCronShares), route(listFiredRuns, c.listFiredRuns),
        ],
        workers,
      };
    },
  });
}

/** The deployed service: it watches object sets for change triggers. */
export const service = createSchedulerService({ watch: true });
