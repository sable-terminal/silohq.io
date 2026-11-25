// pg-control, its reporting replica and the directory database (spec 5.2, 8.1, 8.2).
//
// Each URL points at the cell's transaction-mode pooler (PgBouncer), not at Postgres:
// "Pooling is transaction mode" (spec 8.2). The login in it is the service's own, a
// member of the roles it needs (database README). PG_POOL_MAX bounds this process's
// connections to the pooler; the pooler bounds server connections for every replica.
//
// A service never holds the migration role's credentials: "Application pods never hold
// its credentials" (spec 11.3). Migration jobs read CELL_MIGRATE_URL and
// DIRECTORY_MIGRATE_URL in src/db/scripts, outside this configuration, and connect to
// Postgres directly because they need a session.

import { z } from 'zod';
import { parseSection, read, readSecret, zPositiveInt, zPostgresUrl, type Env } from './env.config.ts';

export const PG_SSL_MODES = ['disable', 'require', 'verify-full'] as const;

const schema = z.object({
  controlUrl: zPostgresUrl.optional(),
  reportUrl: zPostgresUrl.optional(),
  directoryUrl: zPostgresUrl.optional(),
  poolMax: zPositiveInt(200).default(10),
  statementTimeoutMs: zPositiveInt().default(30_000),
  idleInTransactionTimeoutMs: zPositiveInt().default(10_000),
  connectionTimeoutMs: zPositiveInt().default(5_000),
  ssl: z.enum(PG_SSL_MODES).default('disable'),
  sslCaFile: z.string().optional(),
});

export type PostgresConfig = z.output<typeof schema>;

export function loadPostgresConfig(env: Env, problems: string[]): PostgresConfig | undefined {
  const parsed = parseSection(schema, {
    controlUrl: readSecret(env, 'PG_CONTROL_URL', problems),
    reportUrl: readSecret(env, 'PG_REPORT_URL', problems),
    directoryUrl: readSecret(env, 'PG_DIRECTORY_URL', problems),
    poolMax: read(env, 'PG_POOL_MAX'),
    statementTimeoutMs: read(env, 'PG_STATEMENT_TIMEOUT_MS'),
    idleInTransactionTimeoutMs: read(env, 'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS'),
    connectionTimeoutMs: read(env, 'PG_CONNECTION_TIMEOUT_MS'),
    ssl: read(env, 'PG_SSL'),
    sslCaFile: read(env, 'PG_SSL_CA_FILE'),
  }, {
    controlUrl: 'PG_CONTROL_URL', reportUrl: 'PG_REPORT_URL', directoryUrl: 'PG_DIRECTORY_URL',
    poolMax: 'PG_POOL_MAX', statementTimeoutMs: 'PG_STATEMENT_TIMEOUT_MS',
    idleInTransactionTimeoutMs: 'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS', connectionTimeoutMs: 'PG_CONNECTION_TIMEOUT_MS',
    ssl: 'PG_SSL', sslCaFile: 'PG_SSL_CA_FILE',
  }, problems);
  if (!parsed) return undefined;

  for (const [field, variable] of [['controlUrl', 'PG_CONTROL_URL'], ['reportUrl', 'PG_REPORT_URL'], ['directoryUrl', 'PG_DIRECTORY_URL']] as const) {
    const url = parsed[field];
    if (url === undefined) continue;
    const user = new URL(url).username;
    if (user === 'postgres' || /migrate/.test(user)) {
      problems.push(`${variable}: a service never connects as a superuser or migration login (spec 11.3)`);
    }
  }
  return parsed;
}
