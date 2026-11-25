// bigquery-metering (spec 69.7, 69.19, 74.1): provider cost per Silo in Silo's BigQuery,
// recorded for billing at cost plus 10% with the provider cost on each line.

import { measureBigQuery } from '../../contracts/bigquery-metering/metering.contract.ts';
import { meteringController } from '../../controllers/bigquery-metering/metering.controller.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { bigQueryFrom } from '../../services/warehouse-schema/warehouse.service.ts';
import { measureWorker } from '../../workers/bigquery-metering/measure.worker.ts';
import { AppError } from '../../utils/errors.util.ts';

export function createBigQueryMeteringService(options: { bigQuery?: BigQueryAdapter; schedule?: boolean; now?: () => number } = {}) {
  return defineService({
    name: 'bigquery-metering',
    needs: { postgres: ['control'] },
    create(deps) {
      const jobs = deps.config.bigqueryJobs;
      if (jobs.pricePerTibScanned === undefined || jobs.pricePerGibMonthStored === undefined) {
        throw new AppError('configuration', 'BigQuery metering needs the region\'s prices', { code: 'config.bigquery_prices' });
      }
      const bigQuery = options.bigQuery ?? bigQueryFrom(deps.config);
      const shared = {
        databases: deps.databases, logger: deps.logger, bigQuery, projectId: deps.config.bigQuery!.projectId,
        intervalSeconds: jobs.meteringIntervalSeconds, pricePerTibScanned: jobs.pricePerTibScanned, pricePerGibMonthStored: jobs.pricePerGibMonthStored,
        now: options.now ?? Date.now,
      };
      return {
        routes: [route(measureBigQuery, meteringController(shared).measureBigQuery)],
        workers: options.schedule === false ? [] : [measureWorker(shared)],
        close: async () => { if (options.bigQuery === undefined) await bigQuery.close(); },
      };
    },
  });
}

export const service = createBigQueryMeteringService();
