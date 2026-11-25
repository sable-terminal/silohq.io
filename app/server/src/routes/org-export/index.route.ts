// org-export (spec 2.6; docs/siloServiceCatalogue.doc.md): runs exit exports with
// marking-aware omissions and a receipt. Reads as the application role under the
// organisation's context; writes the bundle, manifest and receipt to object-files.

import { downloadOrgExport, getOrgExport, listOrgExports, requestOrgExport } from '../../contracts/org-export/export.contract.ts';
import { exportController } from '../../controllers/org-export/export.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { createObjectStore } from '../../infra/objectStorage.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createExports } from '../../services/org-export/exports.service.ts';
import type { OrgExportDeps } from '../../services/org-export/families.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { exportWorker } from '../../workers/org-export/export.worker.ts';

export function createOrgExportService(options: { now?: () => Date; objects?: OrgExportDeps['objects'] } = {}): ServiceDefinition {
  return defineService({
    name: 'org-export',
    needs: { postgres: ['control'] },
    async create(deps) {
      if (options.objects === undefined && deps.config.objectStorage === undefined) {
        throw new AppError('configuration', 'org-export needs object storage', { code: 'config.org_export' });
      }
      const exports = createExports({
        databases: deps.databases, services: deps.services, logger: deps.logger,
        objects: options.objects ?? await createObjectStore(deps.config.objectStorage!),
        maxArtefactBytes: deps.config.tenantMigrations.exportMaxBytes, ...(options.now ? { now: options.now } : {}),
      });
      const c = exportController(exports);
      return {
        routes: [
          route(requestOrgExport, c.request), route(listOrgExports, c.list), route(getOrgExport, c.get), route(downloadOrgExport, c.download),
        ],
        workers: [exportWorker(exports, deps.config.tenantMigrations.exportTickSeconds * 1000, deps.logger)],
      };
    },
  });
}

export const service: ServiceDefinition = createOrgExportService();
