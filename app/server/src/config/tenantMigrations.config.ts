// Tenant migrations (spec 6.4) and the organisation export (spec 2.6).
//
// Tenant migrations run in the platform workers' process with the migration login of
// MAINTENANCE_DATABASE_URL (maintenance.config.ts): loading an organisation into this cell
// and purging one from it cross tables no application role may write. The export itself
// runs as the application role under the organisation's context.

import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

const schema = z.object({
  tickSeconds: zPositiveInt(3_600).default(30),
  exportTickSeconds: zPositiveInt(3_600).default(30),
  /** The organisation export's ceiling on one artefact, in bytes (each is built in memory; the bundle streams). */
  exportMaxBytes: zPositiveInt(64 * 1024 ** 3).default(2 * 1024 ** 3),
});

export interface TenantMigrationsConfig {
  /** How often the migration stages and the inbox of bundles and receipts are looked at. */
  tickSeconds: number;
  /** How often the organisation export looks for requested exports. */
  exportTickSeconds: number;
  exportMaxBytes: number;
}

export function loadTenantMigrationsConfig(env: Env, problems: string[]): TenantMigrationsConfig | undefined {
  return parseSection(schema, {
    tickSeconds: read(env, 'TENANT_MIGRATIONS_TICK_SECONDS'),
    exportTickSeconds: read(env, 'ORG_EXPORT_TICK_SECONDS'),
    exportMaxBytes: read(env, 'ORG_EXPORT_MAX_BYTES'),
  }, {
    tickSeconds: 'TENANT_MIGRATIONS_TICK_SECONDS', exportTickSeconds: 'ORG_EXPORT_TICK_SECONDS', exportMaxBytes: 'ORG_EXPORT_MAX_BYTES',
  }, problems);
}
