// Tenant migrations (spec 6.4, 6.7; docs/siloServiceCatalogue.doc.md): moves an
// organisation between cells with checksums, re-authorisation and a receipted purge of the
// source. A platform worker: it runs beside maintenance and outbox-relay, and holds the
// migration login (MAINTENANCE_DATABASE_URL) that loading and purging need. The export runs
// as the application role on PG_CONTROL_URL.

import { replayOrganisationPurges as replayOrganisationPurgesContract } from '../../contracts/platform/purgeLedger.contract.ts';
import { replayOrganisationPurges } from '../../services/tenant-migrations/transfer.service.ts';
import * as c from '../../contracts/tenant-migrations/migration.contract.ts';
import { migrationController } from '../../controllers/tenant-migrations/migration.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { createObjectStore } from '../../infra/objectStorage.infra.ts';
import { closePool, createPool } from '../../infra/postgres.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import type { TenantMigrationsDeps } from '../../services/tenant-migrations/deps.service.ts';
import { createRequests } from '../../services/tenant-migrations/requests.service.ts';
import { createStages } from '../../services/tenant-migrations/stages.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { stagesWorker } from '../../workers/tenant-migrations/stages.worker.ts';

export function createTenantMigrationsService(options: { now?: () => Date; objects?: TenantMigrationsDeps['objects'] } = {}): ServiceDefinition {
  return defineService({
    name: 'tenant-migrations',
    needs: { postgres: ['control'] },
    async create(deps) {
      const url = deps.config.maintenance?.databaseUrl;
      if (url === undefined) {
        throw new AppError('configuration', 'tenant-migrations needs MAINTENANCE_DATABASE_URL', { code: 'config.tenant_migrations' });
      }
      if (options.objects === undefined && deps.config.objectStorage === undefined) {
        throw new AppError('configuration', 'tenant-migrations needs object storage', { code: 'config.tenant_migrations' });
      }
      const migrate = createPool({
        ...deps.config.postgres, controlUrl: url, poolMax: 2, statementTimeoutMs: deps.config.maintenance!.statementTimeoutMs,
      }, 'control', 'tenant-migrations', { logger: deps.logger });
      const shared: TenantMigrationsDeps = {
        databases: deps.databases, migrate, objects: options.objects ?? await createObjectStore(deps.config.objectStorage!), services: deps.services,
        logger: deps.logger, cellId: deps.config.cell.id, directory: deps.config.http.serviceUrls['directory'] !== undefined,
        ...(options.now ? { now: options.now } : {}),
      };
      const handlers = migrationController(createRequests(shared));
      const stages = createStages(shared);
      return {
        routes: [
          route(c.getResidency, handlers.residency), route(c.listTenantMigrations, handlers.list),
          route(c.getTenantImportKey, handlers.importKey), route(c.getTenantMigration, handlers.get),
          route(c.requestTenantMigration, handlers.request), route(c.respondToRebalancing, handlers.respond),
          route(c.withdrawTenantMigration, handlers.withdraw), route(c.proposeRebalancing, handlers.propose),
          route(c.signTenantMigration, handlers.sign), route(c.scheduleTenantMigration, handlers.schedule),
          route(c.abortTenantMigration, handlers.abort),
          // After a restore, before traffic (8.2, 12.5; D251).
          route(replayOrganisationPurgesContract, { handle: (input) => replayOrganisationPurges(shared, input.body.entries) }),
        ],
        workers: [stagesWorker(stages, deps.config.tenantMigrations.tickSeconds * 1000, deps.logger)],
        close: () => closePool(migrate),
      };
    },
  });
}

export const service: ServiceDefinition = createTenantMigrationsService();
