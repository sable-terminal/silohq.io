// The scheduler (spec 40.7): how often it looks for due Crons, how many it takes at once,
// and the shortest interval a schedule may have.
//
// The minimum interval is per plan in the spec, with no values stated (open decision,
// spec 40.12): one cell-wide floor until plans carry their own. A schedule whose next
// occurrences come closer than the floor is refused at creation, naming it.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({
  tickMs: zPositiveInt(600_000).default(15_000),
  batch: zPositiveInt(1_000).default(50),
  minIntervalMinutes: zPositiveInt(1_440).default(15),
  concurrency: zPositiveInt(64).default(4),
});

export interface SchedulerConfig {
  /** How often the due sweep runs. A Cron runs within one tick of its time. */
  tickMs: number;
  /** Crons claimed per sweep. */
  batch: number;
  minIntervalMinutes: number;
  /** Runs in flight at once in one process. */
  concurrency: number;
}

export function loadSchedulerConfig(env: Env, problems: string[]): SchedulerConfig | undefined {
  return parseSection(schema, {
    tickMs: read(env, 'SCHEDULER_TICK_MS'),
    batch: read(env, 'SCHEDULER_BATCH'),
    minIntervalMinutes: read(env, 'SCHEDULER_MIN_INTERVAL_MINUTES'),
    concurrency: read(env, 'SCHEDULER_CONCURRENCY'),
  }, {
    tickMs: 'SCHEDULER_TICK_MS', batch: 'SCHEDULER_BATCH', minIntervalMinutes: 'SCHEDULER_MIN_INTERVAL_MINUTES',
    concurrency: 'SCHEDULER_CONCURRENCY',
  }, problems);
}
