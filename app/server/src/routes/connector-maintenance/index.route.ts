// connector-maintenance (catalogue; spec 17.3 to 17.5): the weekly re-check, drift detection
// and self-heal. Tests through conformance, observes through connect-runtime, charges repairs
// through metering, decisions through policy; records in connect.probe_runs (stage recheck)
// and connect.heal_proposals.

import {
  decideHealProposal, getHealProposal, getRecheck, listHealProposals, listRechecks, reportSourceDrift, requestRecheck,
} from '../../contracts/connector-maintenance/maintenance.contract.ts';
import { maintenanceController } from '../../controllers/connector-maintenance/maintenance.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import type { MaintenanceDeps } from '../../services/connector-maintenance/deps.service.ts';
import { createHeals } from '../../services/connector-maintenance/heals.service.ts';
import { createRechecks } from '../../services/connector-maintenance/recheck.service.ts';
import { WEEKLY_DEFAULTS, weeklyRecheckWorker, type WeeklySettings } from '../../workers/connector-maintenance/weekly.worker.ts';

export interface MaintenanceOptions {
  weekly?: Partial<WeeklySettings>;
  /** How long a re-check or a sandbox waits for its conformance run. */
  runTimeoutMs?: number;
  pollMs?: number;
}

export function createConnectorMaintenanceService(options: MaintenanceOptions = {}): ServiceDefinition {
  return defineService({
    name: 'connector-maintenance',
    // redis-data: idempotency keys and the per-connection re-check lock.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const stopping = new AbortController();
      const maintenance: MaintenanceDeps = {
        databases: deps.databases, services: deps.services, data: deps.redis.data!, logger: deps.logger,
        runTimeoutMs: options.runTimeoutMs ?? 20 * 60_000, pollMs: options.pollMs ?? 1_000, signal: stopping.signal,
      };
      const heals = createHeals(maintenance);
      const rechecks = createRechecks(maintenance, heals);
      const pending = new Set<Promise<unknown>>();
      const background = (work: Promise<unknown>): void => {
        pending.add(work);
        void work.finally(() => pending.delete(work));
      };
      const c = maintenanceController(rechecks, heals, background);
      return {
        routes: [
          route(requestRecheck, c.requestRecheck), route(reportSourceDrift, c.reportSourceDrift), route(getRecheck, c.getRecheck),
          route(listRechecks, c.listRechecks), route(listHealProposals, c.listHealProposals), route(getHealProposal, c.getHealProposal),
          route(decideHealProposal, c.decideHealProposal),
        ],
        workers: [weeklyRecheckWorker(deps.databases, rechecks, deps.logger, { ...WEEKLY_DEFAULTS, ...options.weekly })],
        close: async () => {
          stopping.abort();
          await rechecks.close();
          await Promise.allSettled([...pending]);
        },
      };
    },
  });
}

export const service = createConnectorMaintenanceService();
