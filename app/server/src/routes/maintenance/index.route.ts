// The maintenance service (docs/siloServiceCatalogue.doc.md): partitions ahead, seals,
// retention drops, expiry sweeps, and an alert when any falls behind.
//
// It needs no pool of the shared kind: it opens its own, on MAINTENANCE_DATABASE_URL, a
// login in silo_migrate that only the platform workers' deployment holds (spec 11.3; the
// configuration refuses it anywhere else), with a statement timeout long enough for a
// partition move.

import { maintenanceStatus } from '../../contracts/maintenance/status.contract.ts';
import { statusController } from '../../controllers/maintenance/status.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { closePool, createPool } from '../../infra/postgres.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createMaintenance } from '../../services/maintenance/maintenance.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { maintenanceWorker } from '../../workers/maintenance/maintenance.worker.ts';

export const service: ServiceDefinition = defineService({
  name: 'maintenance',
  needs: {},
  create(deps) {
    const config = deps.config.maintenance;
    if (config?.databaseUrl === undefined) {
      throw new AppError('configuration', 'maintenance needs MAINTENANCE_DATABASE_URL', { code: 'config.maintenance' });
    }
    const pool = createPool({
      ...deps.config.postgres, controlUrl: config.databaseUrl, poolMax: 2, statementTimeoutMs: config.statementTimeoutMs,
    }, 'control', 'maintenance', { logger: deps.logger });
    const maintenance = createMaintenance({ pool, config, logger: deps.logger });
    return {
      routes: [route(maintenanceStatus, statusController(maintenance).maintenanceStatus)],
      workers: [maintenanceWorker(maintenance, config.intervalSeconds * 1000)],
      close: () => closePool(pool),
    };
  },
});
