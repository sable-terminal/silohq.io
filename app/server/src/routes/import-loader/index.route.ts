// import-loader (catalogue: Siloes Import storage; spec 68.4, 68.6): the rows siloes-import
// extracts, held in the Import Silo's BigQuery dataset, purged with their file.

import {
  confirmImportValues, dropExpiredImportRows, dropImportDataset, loadImportRows, purgeImportFile, purgeImportObject,
} from '../../contracts/import-loader/load.contract.ts';
import { loadController } from '../../controllers/import-loader/load.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';

export function createImportLoaderService(options: { bigQuery?: BigQueryAdapter } = {}) {
  return defineService({
    name: 'import-loader',
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const c = loadController({
        databases: deps.databases, logger: deps.logger, bigQuery, projectId: deps.config.bigQuery!.projectId,
        maxRows: deps.config.bigqueryJobs.importMaxRows,
      });
      return {
        routes: [
          route(loadImportRows, c.loadImportRows), route(purgeImportFile, c.purgeImportFile), route(confirmImportValues, c.confirmImportValues),
          route(dropExpiredImportRows, c.dropExpiredImportRows), route(dropImportDataset, c.dropImportDataset), route(purgeImportObject, c.purgeImportObject),
        ],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createImportLoaderService();
