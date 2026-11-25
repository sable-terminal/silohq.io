// Publishes the status page: at start, after any change (a quarter of a second later, so
// a burst of reports is one write), and every STATUS_PUBLISH_INTERVAL_SECONDS, so a cell
// that goes quiet turns unknown on the page without anyone reporting it. A failed write
// is logged and tried again; the page stays as it was until then (spec 7.2: "Page stale").
// On shutdown a change not yet published is published before the worker stops, so a
// notice written just before a deploy is not lost with the process.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { StatusPublisher } from '../../services/status/publisher.service.ts';
import type { StatusBoard } from '../../services/status/status.service.ts';
import { sleep } from '../../utils/time.util.ts';

const BATCH_MS = 250;

export function publishWorker(options: {
  board: StatusBoard;
  publisher: StatusPublisher;
  intervalSeconds: number;
  logger: Logger;
}): Worker {
  const { board, publisher, logger } = options;
  let wake: (() => void) | undefined;
  let dirty = false;
  board.onChange(() => {
    dirty = true;
    wake?.();
  });

  const publish = async (): Promise<void> => {
    dirty = false;
    try {
      const document = await board.publish((latest) => publisher.publish(latest));
      logger.debug('status page published', { event: 'status.published', count: document.cells.length });
    } catch (error) {
      logger.failure('the status page could not be published; it stays as it was', error, { event: 'status.publish_failed' });
    }
  };

  return {
    name: 'status.publish',
    async run(signal) {
      while (!signal.aborted) {
        await publish();
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            sleep(options.intervalSeconds * 1000, signal).then(resolve, resolve);
          });
          wake = undefined;
        }
        if (signal.aborted) break;
        await sleep(BATCH_MS, signal).catch(() => undefined);
      }
      if (dirty) await publish();
    },
  };
}
