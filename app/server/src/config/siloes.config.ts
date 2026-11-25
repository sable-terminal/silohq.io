// Siloes Capture and Import (spec 67, 68, 70, 74.1): how often the capture queue is written,
// purges are advanced, retention is swept and files are processed; the largest file taken
// in one upload; and the provider prices Capture (Postgres) and Import files (object
// storage) are metered at. The prices have no defaults: a price nobody set is never billed
// as zero, so each service refuses to start without its own.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const price = z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, 'must be a price in pounds, such as 0.20');

const schema = z.object({
  captureDrainSeconds: zPositiveInt(300).default(5),
  purgePollSeconds: zPositiveInt(3_600).default(10),
  retentionSweepSeconds: zPositiveInt(7 * 86_400).default(86_400),
  importProcessSeconds: zPositiveInt(3_600).default(10),
  importMaxFileBytes: zPositiveInt(32 * 1024 * 1024).default(25 * 1024 * 1024),
  postgresPricePerGibMonth: price.optional(),
  storagePricePerGibMonth: price.optional(),
});

export interface SiloesConfig {
  captureDrainSeconds: number;
  purgePollSeconds: number;
  retentionSweepSeconds: number;
  importProcessSeconds: number;
  /** Bytes one uploaded file may have. */
  importMaxFileBytes: number;
  /** Pounds per GiB-month held in Postgres by Capture (required by siloes-capture). */
  postgresPricePerGibMonth: string | undefined;
  /** Pounds per GiB-month of Import files in object storage (required by siloes-import). */
  storagePricePerGibMonth: string | undefined;
}

export function loadSiloesConfig(env: Env, problems: string[]): SiloesConfig | undefined {
  const parsed = parseSection(schema, {
    captureDrainSeconds: read(env, 'SILOES_CAPTURE_DRAIN_SECONDS'),
    purgePollSeconds: read(env, 'SILOES_PURGE_POLL_SECONDS'),
    retentionSweepSeconds: read(env, 'SILOES_RETENTION_SWEEP_SECONDS'),
    importProcessSeconds: read(env, 'SILOES_IMPORT_PROCESS_SECONDS'),
    importMaxFileBytes: read(env, 'SILOES_IMPORT_MAX_FILE_BYTES'),
    postgresPricePerGibMonth: read(env, 'SILOES_POSTGRES_PRICE_PER_GIB_MONTH'),
    storagePricePerGibMonth: read(env, 'SILOES_STORAGE_PRICE_PER_GIB_MONTH'),
  }, {
    captureDrainSeconds: 'SILOES_CAPTURE_DRAIN_SECONDS', purgePollSeconds: 'SILOES_PURGE_POLL_SECONDS',
    retentionSweepSeconds: 'SILOES_RETENTION_SWEEP_SECONDS', importProcessSeconds: 'SILOES_IMPORT_PROCESS_SECONDS',
    importMaxFileBytes: 'SILOES_IMPORT_MAX_FILE_BYTES', postgresPricePerGibMonth: 'SILOES_POSTGRES_PRICE_PER_GIB_MONTH',
    storagePricePerGibMonth: 'SILOES_STORAGE_PRICE_PER_GIB_MONTH',
  }, problems);
  return parsed === undefined ? undefined : {
    ...parsed, postgresPricePerGibMonth: parsed.postgresPricePerGibMonth ?? undefined, storagePricePerGibMonth: parsed.storagePricePerGibMonth ?? undefined,
  };
}
