// siloes-import (catalogue; spec 68, 70.7): file intake, structuring definitions and
// extraction, including the document carve-out.

import * as c from '../../contracts/siloes/import.contract.ts';
import { importController } from '../../controllers/siloes-import/import.controller.ts';
import { cellLocation } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { importWorkers } from '../../workers/siloes-import/import.worker.ts';

export function createSiloesImportService(options: { store?: ObjectStore; schedule?: boolean; now?: () => number } = {}) {
  return defineService({
    name: 'siloes-import',
    needs: { postgres: ['control'], redis: ['data'] },
    async create(deps) {
      const config = deps.config.siloes;
      if (config.storagePricePerGibMonth === undefined) {
        throw new AppError('configuration', 'Import metering needs the region\'s storage price', { code: 'config.siloes_prices' });
      }
      const storage = deps.config.objectStorage;
      if (options.store === undefined && storage?.siloesBucket === undefined) {
        throw new AppError('configuration', 'Import needs the siloes bucket (OBJECT_BUCKET_SILOES)', { code: 'config.siloes_storage' });
      }
      const store = options.store ?? await createObjectStore(storage!);
      const shared = {
        databases: deps.databases, services: deps.services, logger: deps.logger, store,
        location: deps.config.bigQuery?.location ?? cellLocation(deps.config.cell.id, deps.config.cell.residency),
        maxFileBytes: config.importMaxFileBytes, loadRows: deps.config.bigqueryJobs.importMaxRows, now: options.now ?? Date.now,
      };
      const h = importController(shared);
      return {
        routes: [
          route(c.createImportSilo, h.createImportSilo), route(c.acknowledgeCarveout, h.acknowledgeCarveout), route(c.publishDefinition, h.publishDefinition),
          route(c.listDefinitions, h.listDefinitions), route(c.listPrebuiltDefinitions, h.listPrebuiltDefinitions), route(c.draftDefinition, h.draftDefinition), route(c.createSource, h.createSource), route(c.listSources, h.listSources), route(c.uploadFile, h.uploadFile), route(c.beginUpload, h.beginUpload), route(c.completeUpload, h.completeUpload),
          route(c.rebuildImportSilo, h.rebuildImportSilo), route(c.listFiles, h.listFiles), route(c.getExtraction, h.getExtraction), route(c.readRecordExtractions, h.readRecordExtractions), route(c.listExtractions, h.listExtractions),
          route(c.confirmExtraction, h.confirmExtraction), route(c.storeFilesUpload, h.storeFilesUpload), route(c.readFilesUpload, h.readFilesUpload), route(c.getFilesUpload, h.getFilesUpload),
          route(c.beginFilesUpload, h.beginFilesUpload), route(c.completeFilesUpload, h.completeFilesUpload), route(c.signFilesUploadRead, h.signFilesUploadRead),
          route(c.checkFilesSilo, h.checkFilesSilo), route(c.openMediaUpload, h.openMediaUpload),
        ],
        workers: options.schedule === false ? [] : importWorkers(shared, {
          processSeconds: config.importProcessSeconds, meteringSeconds: deps.config.bigqueryJobs.meteringIntervalSeconds,
          pricePerGibMonth: config.storagePricePerGibMonth,
        }),
      };
    },
  });
}

export const service = createSiloesImportService();
