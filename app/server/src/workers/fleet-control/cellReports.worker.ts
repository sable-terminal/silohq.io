// The cell's Fleet agent reporting to the global tier (services/fleet-control/cellReports.service.ts):
// every FLEET_REPORT_SECONDS its status, its customer's change policy and Fleet's events about it;
// its registration at start and every hour. Each part fails alone, logged, and is tried at the
// next tick: a status that stops arriving shows as unknown on the page, as it should.

import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { CellReports } from '../../services/fleet-control/cellReports.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';

export function cellReportsWorker(options: { reports: CellReports; intervalMs: number; logger: Logger }): Worker {
  const registerEvery = Math.max(1, Math.round(3_600_000 / options.intervalMs));
  return {
    name: 'fleet.cell-reports',
    async run(signal) {
      for (let tick = 0; !signal.aborted; tick++) {
        const correlationId = uuidv7();
        const parts: [string, () => Promise<unknown>][] = [
          ...(tick % registerEvery === 0 ? [['register', () => options.reports.register(correlationId)] as [string, () => Promise<unknown>]] : []),
          ['status', () => options.reports.reportStatus(correlationId)],
          ['change_policy', () => options.reports.carryPolicy(correlationId)],
          ['events', () => options.reports.copyEvents(correlationId)],
          ['incidents', () => options.reports.copyIncidents(correlationId)],
          ['redactions', () => options.reports.copyRedactions(correlationId)],
          ['templates', () => options.reports.carryTemplates(correlationId)],
        ];
        for (const [name, part] of parts) {
          await part().catch((error: unknown) => {
            options.logger.failure(`the cell's ${name.replace('_', ' ')} could not be reported; trying again`, error, { event: 'fleet.cell_report_failed', reason: name });
          });
        }
        await sleep(options.intervalMs, signal).catch(() => undefined);
      }
    },
  };
}
