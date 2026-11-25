// Test harness: a fresh cell and directory database per test file, bootstrapped and
// migrated exactly as a real cell is, plus a login per database role so tests act
// as the services do. Needs the local container (npm run db:up).

import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bootstrapDatabase, DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { migrate } from '../../src/db/scripts/migrate.script.ts';
import { connectionDefaults } from '../../src/infra/postgres.infra.ts';

const ADMIN_URL = process.env['TEST_PG_ADMIN_URL'] ?? DEFAULT_ADMIN_URL;
const PASSWORD = 'test';

// Login role -> group roles it belongs to. Mirrors how a deployment gives each
// service its own login.
export const LOGINS = {
  test_migrate: ['silo_migrate'],
  test_app: ['silo_app'],
  test_auth: ['silo_auth', 'silo_app'],
  test_audit: ['silo_audit_writer'],
  // The audit service as deployed: the ledger writer, and silo_app to read scopes, grants and the unwrap ledger.
  test_audit_service: ['silo_audit_writer', 'silo_app'],
  test_report: ['silo_report'],
  test_relay: ['silo_outbox_relay'],
  test_credential: ['silo_credential', 'silo_app'],
  test_billing: ['silo_billing', 'silo_app'],
  test_model_gateway: ['silo_audit_writer', 'silo_app'],
  test_dir_migrate: ['directory_migrate'],
  test_dir_writer: ['directory_writer'],
  test_dir_reader: ['directory_reader'],
  test_status: ['status_writer'],
  test_fleet: ['fleet_writer'],
} as const satisfies Record<string, readonly string[]>;

export type Login = keyof typeof LOGINS;

export interface Harness {
  cell: string;
  directory: string;
  connect(login: Login, database?: 'cell' | 'directory'): Promise<pg.Client>;
  migrateUrl(database: 'cell' | 'directory'): string;
  /** A login's connection URL, for a service process under test. */
  url(login: Login, database?: 'cell' | 'directory'): string;
  close(): Promise<void>;
}

async function ensureLogins(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const [login, groups] of Object.entries(LOGINS)) {
      const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [login]);
      if (!rowCount) {
        try {
          await admin.query(`create role ${login} login password '${PASSWORD}'`);
        } catch (error) {
          if ((error as { code?: string }).code !== '42710') throw error; // created concurrently
        }
      }
      for (const group of groups) await admin.query(`grant ${group} to ${login}`);
    }
  } finally {
    await admin.end();
  }
}

export async function createHarness(): Promise<Harness> {
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`;
  const cell = `silo_test_cell_${suffix}`;
  const directory = `silo_test_dir_${suffix}`;

  await bootstrapDatabase(ADMIN_URL, cell, 'cell');
  await bootstrapDatabase(ADMIN_URL, directory, 'directory');
  await ensureLogins();

  const quiet = (): void => undefined;
  await migrate('cell', urlFor(ADMIN_URL, cell, 'test_migrate', PASSWORD), quiet);
  await migrate('directory', urlFor(ADMIN_URL, directory, 'test_dir_migrate', PASSWORD), quiet);

  const clients: pg.Client[] = [];

  return {
    cell,
    directory,
    migrateUrl(database) {
      return database === 'cell'
        ? urlFor(ADMIN_URL, cell, 'test_migrate', PASSWORD)
        : urlFor(ADMIN_URL, directory, 'test_dir_migrate', PASSWORD);
    },
    url(login, database = 'cell') {
      return urlFor(ADMIN_URL, database === 'cell' ? cell : directory, login, PASSWORD);
    },
    async connect(login, database = 'cell') {
      // Connected as the services connect, so tests see the values the models describe.
      const client = new pg.Client({
        connectionString: urlFor(ADMIN_URL, database === 'cell' ? cell : directory, login, PASSWORD),
        ...connectionDefaults,
      });
      await client.connect();
      // The migration logins act as the migration role, as the runner does.
      if (login === 'test_migrate') await client.query('set role silo_migrate');
      if (login === 'test_dir_migrate') await client.query('set role directory_migrate');
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      try {
        for (const db of [cell, directory]) {
          await admin.query(
            'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
            [db],
          );
          await admin.query(`drop database if exists ${db}`);
        }
      } finally {
        await admin.end();
      }
    },
  };
}

export interface Context {
  orgId?: string;
  userId?: string;
}

// Runs fn in one transaction with app.org_id and app.user_id set locally, as every
// service does (build rules: SET LOCAL, never SET). Rolls back on error.
export async function inTx<T>(client: pg.Client, context: Context, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    if (context.orgId) await client.query(`select set_config('app.org_id', $1, true)`, [context.orgId]);
    if (context.userId) await client.query(`select set_config('app.user_id', $1, true)`, [context.userId]);
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

// Ids come from the same helper services use.
export { uuidv7 } from '../../src/utils/id.util.ts';

export function sha256Bytes(): Buffer {
  return randomBytes(32);
}

export const ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

export { randomUUID };
