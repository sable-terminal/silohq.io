// Ontology's retirement reminder sweep (spec 25.7): seven days before a deprecated element
// retires, the owners of its dependants are told again. Runs hourly; a reminder is sent once.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { RetirementReminders } from '../../services/ontology/retirementNotices.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export const REMINDER_SWEEP_MS = 3_600_000;

/** Waits, or less if the service stops: the timer is cleared, so an hour's wait never holds the process open. */
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const stop = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', stop);
    resolve();
  }, ms);
  signal.addEventListener('abort', stop, { once: true });
});

export function retirementReminderWorker(reminders: RetirementReminders, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'ontology-retirement-reminders',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await reminders.sendDue(uuidv7());
        } catch (error) {
          logger.failure('the retirement reminder sweep failed; it runs again', error, { event: 'ontology.reminder_sweep_failed' });
        }
        await pause(intervalMs, signal);
      }
    },
  };
}
