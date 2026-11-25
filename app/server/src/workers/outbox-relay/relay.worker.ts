// The relay loop. A pass that published something is followed at once by another, since
// publishing a head makes the row behind it due; an empty or all-failed pass waits
// idleMs. A database or bus outage is retried with backoff up to 30 seconds rather than
// stopping the process: rows wait safely in the outbox meanwhile.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { Relay } from '../../services/outbox-relay/relay.service.ts';
import { sleep } from '../../utils/time.util.ts';

export function relayWorker(relay: Relay, logger: Logger, idleMs = 250): Worker {
  return {
    name: 'outbox-relay',
    async run(signal) {
      let failures = 0;
      while (!signal.aborted) {
        let wait = idleMs;
        try {
          const result = await relay.pass();
          failures = 0;
          if (result.published > 0 || result.claimed === relay.options.batchSize) wait = 0;
        } catch (error) {
          failures += 1;
          wait = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
          logger.failure('an outbox relay pass failed; retrying', error, { event: 'outbox.pass_failed', attempt: failures, durationMs: wait });
        }
        if (wait > 0) await sleep(wait, signal).catch(() => undefined);
      }
    },
  };
}
