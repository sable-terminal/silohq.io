// The audit consumer: audit.events from bus-durable into the ledger. Messages arrive one
// at a time per consumer; a throw from the writer redelivers the message.

import type { DurableBus } from '../../infra/bus.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { AuditWriter } from '../../services/audit/writer.service.ts';

export function consumerWorker(bus: DurableBus, writer: AuditWriter, consumer: string): Worker {
  return {
    name: 'audit-consumer',
    async run(signal) {
      const stop = await bus.subscribe('audit.events', consumer, async (message) => {
        await writer.handle(message);
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await stop();
    },
  };
}
