// auth's retry of directory registrations the directory missed (spec 55.1; D69).

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { DirectoryRegistrar } from '../../services/auth/directory.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';

/** Waits, or less if the service stops: the timer is cleared on stop. */
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

export function directoryRetryWorker(registrar: DirectoryRegistrar, intervalMs: number, logger: Logger): Worker {
  return {
    name: 'auth-directory-retry',
    async run(signal) {
      while (!signal.aborted) {
        try {
          await registrar.retryPending(uuidv7());
        } catch (error) {
          logger.failure('the directory registration retry failed; it runs again', error, { event: 'directory.retry_failed' });
        }
        await pause(intervalMs, signal);
      }
    },
  };
}
