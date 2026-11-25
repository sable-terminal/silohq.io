// index-builder (spec 69.1 to 69.11): the Object Index. Nominations, scheduled refresh into
// the BigQuery baseline (the engine is open decision 69.6), and search for the search service.

import { applyIndexObservations } from '../../contracts/index-builder/observations.contract.ts';
import {
  addIndexType, changeIndexProperties, createObjectIndex, exportObjectIndex, getObjectIndex, purgeObjectIndex, rebuildIndexType, removeIndexType,
  objectIndexCoverage, readObjectIndex, searchObjectIndex, sweepObjectIndex,
} from '../../contracts/index-builder/index.contract.ts';
import { indexController } from '../../controllers/index-builder/index.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';
import { refreshWorker } from '../../workers/index-builder/refresh.worker.ts';

export function createIndexBuilderService(options: { bigQuery?: BigQueryAdapter; schedule?: boolean } = {}) {
  return defineService({
    name: 'index-builder',
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const shared = {
        databases: deps.databases, services: deps.services, logger: deps.logger, bigQuery, projectId: deps.config.bigQuery!.projectId,
        batchRows: deps.config.warehouse.batchRows, maxResults: deps.config.bigqueryJobs.indexMaxResults,
        minIntervalMinutes: deps.config.scheduler.minIntervalMinutes,
      };
      const c = indexController(shared);
      return {
        routes: [
          route(createObjectIndex, c.createObjectIndex), route(getObjectIndex, c.getObjectIndex), route(addIndexType, c.addIndexType),
          route(changeIndexProperties, c.changeIndexProperties), route(removeIndexType, c.removeIndexType), route(rebuildIndexType, c.rebuildIndexType),
          route(searchObjectIndex, c.searchObjectIndex), route(purgeObjectIndex, c.purgeObjectIndex), route(sweepObjectIndex, c.sweepObjectIndex),
          route(objectIndexCoverage, c.objectIndexCoverage), route(readObjectIndex, c.readObjectIndex),
          route(exportObjectIndex, c.exportObjectIndex),
          // Change streams between refreshes, from the Siloes' observation queue (69.4).
          route(applyIndexObservations, c.applyIndexObservations),
        ],
        workers: options.schedule === false ? [] : [refreshWorker(shared, deps.config.bigqueryJobs.indexTickSeconds)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createIndexBuilderService();
