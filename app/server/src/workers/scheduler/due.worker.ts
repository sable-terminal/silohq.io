// The due sweep (spec 40.7): every tick, claims the Crons whose time has come
// (automation.claim_due_automations: a lease, so two replicas never take the same run),
// moves each to its next time from now, and runs it.
//
// Missed runs are not backfilled: a Cron that missed occurrences while nothing ran reports
// the gap (automation_run_skipped, reason missed, with the count) and runs once, now. A Cron
// that watches (spec 40.2) is due only when a change made it so: it runs once, with trigger
// change, and waits for the next.

import type { Worker } from '../../infra/service.infra.ts';
import { processLoad } from '../../infra/load.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { automationRepo } from '../../repos/automation/index.repo.ts';
import { cronActor, recordEvent, type SchedulerDeps } from '../../services/scheduler/deps.service.ts';
import { runCron } from '../../services/scheduler/runner.service.ts';
import { missedBetween, nextOccurrence, parseSchedule } from '../../services/scheduler/schedule.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function dueWorker(deps: SchedulerDeps): Worker {
  const control = deps.databases.pool('control');
  const inFlight = new Set<Promise<void>>();

  async function take(organisationId: string, id: string, dueAt: string): Promise<void> {
    const now = deps.now();
    const moved = await inTransaction(control, { organisationId }, async (db): Promise<'schedule' | 'change' | false> => {
      const row = await automationRepo.findForUpdate(db, id);
      if (!row || row.status !== 'active' || row.deletedAt !== null) return false;
      if (row.schedule === null) {
        if (row.watch === null) return false;
        await automationRepo.update(db, id, { nextRunAt: null, leaseExpiresAt: null });
        return 'change';
      }
      const schedule = parseSchedule(row.schedule);
      const next = nextOccurrence(schedule, now, row.timezone);
      await automationRepo.update(db, id, { nextRunAt: next === undefined ? null : new Date(next).toISOString(), leaseExpiresAt: null });
      const missed = missedBetween(schedule, Date.parse(dueAt), now, row.timezone);
      if (missed > 0) {
        await recordEvent(db, organisationId, uuidv7(), {
          event: 'automation_run_skipped', actor: cronActor(row.servicePrincipalId), resource: { type: 'automation', id },
          detail: { reason: 'missed', missed },
        });
      }
      // Shed under load (12.4): this run is a missed run, reported, and not backfilled; the Cron runs at its next time.
      if (processLoad().sheds('cron')) {
        await recordEvent(db, organisationId, uuidv7(), {
          event: 'automation_run_skipped', actor: cronActor(row.servicePrincipalId), resource: { type: 'automation', id },
          detail: { reason: 'capacity', missed: 1 },
        });
        return false;
      }
      return 'schedule';
    });
    if (moved !== false) await (await runCron(deps, organisationId, id, moved)).done;
  }

  return {
    name: 'scheduler-due',
    async run(signal) {
      while (!signal.aborted) {
        try {
          const room = Math.max(0, deps.config.concurrency - inFlight.size);
          const due = room === 0 ? [] : await inTransaction(control, {}, (db) =>
            automationRepo.claimDue(db, Math.min(room, deps.config.batch), new Date(deps.now()).toISOString()));
          for (const claim of due) {
            const job: Promise<void> = take(claim.organisationId, claim.id, claim.nextRunAt)
              .catch((error: unknown) => {
                deps.logger.failure('a due Cron could not be run; its lease lapses and the next sweep retries', error, {
                  event: 'scheduler.due_failed', organisationId: claim.organisationId, resourceId: claim.id,
                });
              })
              .finally(() => { inFlight.delete(job); });
            inFlight.add(job);
          }
        } catch (error) {
          deps.logger.failure('the due sweep failed; the next tick retries', error, { event: 'scheduler.sweep_failed' });
        }
        await sleep(deps.config.tickMs, signal).catch(() => undefined);
      }
      await Promise.allSettled([...inFlight]);
    },
  };
}
