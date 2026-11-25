// The BigQuery jobs of Siloes (spec 68.6, 69, 74.1): the Import row loader, the Object
// Index refresh and search, BigQuery metering, and Warehouse direct access.
//
// The cell's siloes project and its location are BIGQUERY_PROJECT_ID and BIGQUERY_LOCATION
// (storage.config.ts). Provider prices are the cell region's list prices in pounds, set by
// Fleet from the provider's price list; metering records them as the provider cost and the
// billing service adds the margin (spec 74.1: the provider cost is shown per line). They
// have no defaults: a price nobody set is never billed as zero.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const price = z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, 'must be a price in pounds, such as 4.80');

const schema = z.object({
  importMaxRows: zPositiveInt(100_000).default(10_000),
  indexTickSeconds: zPositiveInt(3_600).default(60),
  indexMaxResults: zPositiveInt(1_000).default(100),
  meteringIntervalSeconds: zPositiveInt(86_400).default(86_400),
  pricePerTibScanned: price.optional(),
  pricePerGibMonthStored: price.optional(),
});

export interface BigQueryJobsConfig {
  /** Rows one load request may carry; a larger file is loaded in several requests. */
  importMaxRows: number;
  /** How often the Object Index looks for definitions due a refresh. */
  indexTickSeconds: number;
  /** Results one index search returns at most. */
  indexMaxResults: number;
  /** How often BigQuery metering measures (daily by default, per the design's metering hooks). */
  meteringIntervalSeconds: number;
  /** Pounds per TiB billed for query and DML bytes, at the cell region's on-demand rate. */
  pricePerTibScanned: string | undefined;
  /** Pounds per GiB-month of logical storage held, at the cell region's rate. */
  pricePerGibMonthStored: string | undefined;
}

export function loadBigQueryJobsConfig(env: Env, problems: string[]): BigQueryJobsConfig | undefined {
  const parsed = parseSection(schema, {
    importMaxRows: read(env, 'IMPORT_LOADER_MAX_ROWS'),
    indexTickSeconds: read(env, 'OBJECT_INDEX_TICK_SECONDS'),
    indexMaxResults: read(env, 'OBJECT_INDEX_MAX_RESULTS'),
    meteringIntervalSeconds: read(env, 'BIGQUERY_METERING_INTERVAL_SECONDS'),
    pricePerTibScanned: read(env, 'BIGQUERY_PRICE_PER_TIB_SCANNED'),
    pricePerGibMonthStored: read(env, 'BIGQUERY_PRICE_PER_GIB_MONTH_STORED'),
  }, {
    importMaxRows: 'IMPORT_LOADER_MAX_ROWS', indexTickSeconds: 'OBJECT_INDEX_TICK_SECONDS', indexMaxResults: 'OBJECT_INDEX_MAX_RESULTS',
    meteringIntervalSeconds: 'BIGQUERY_METERING_INTERVAL_SECONDS', pricePerTibScanned: 'BIGQUERY_PRICE_PER_TIB_SCANNED',
    pricePerGibMonthStored: 'BIGQUERY_PRICE_PER_GIB_MONTH_STORED',
  }, problems);
  return parsed === undefined ? undefined : {
    ...parsed, pricePerTibScanned: parsed.pricePerTibScanned ?? undefined, pricePerGibMonthStored: parsed.pricePerGibMonthStored ?? undefined,
  };
}
