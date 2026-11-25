// Notify's Action event workers (spec 48.3): the bus consumer that turns executed Actions
// into deliveries, and the sweep that delivers what is due.

import type { DurableBus } from '../../infra/bus.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { ActionEventDelivery } from '../../services/notify/actionEvents.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';

const untilAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener('abort', () => resolve(), { once: true });
});

export function actionEventConsumerWorker(bus: DurableBus, delivery: ActionEventDelivery, consumer: string): Worker {
  return {
    name: 'notify-action-events',
    async run(signal) {
      const stop = await bus.subscribe('control.action', consumer, async (message) => {
        await delivery.intake(message);
      });
      await untilAborted(signal);
      await stop();
    },
  };
}

export function actionEventDeliveryWorker(delivery: Pick<ActionEventDelivery, 'deliverDue'> | { deliverDue(correlationId: string): Promise<unknown> }, intervalMs: number,
  logger: Logger, name = 'notify-action-event-delivery'): Worker {
  return {
    name,
    async run(signal) {
      while (!signal.aborted) {
        try {
          await delivery.deliverDue(uuidv7());
        } catch (error) {
          logger.failure('the Action event delivery sweep failed; it runs again', error, { event: 'notify.action_event_sweep_failed' });
        }
        await Promise.race([new Promise((resolve) => setTimeout(resolve, intervalMs)), untilAborted(signal)]);
      }
    },
  };
}
