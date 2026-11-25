// Local development only: creates the cell and directory databases in the local
// container and runs the bootstrap SQL in each, as the container's superuser. In a
// real cell, Fleet runs src/db/bootstrap/*.bootstrap.sql with the cluster administrator.
//
// Usage: node src/db/scripts/bootstrapLocal.script.ts
//   LOCAL_ADMIN_URL defaults to postgres://postgres:postgres@127.0.0.1:55432/postgres

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

export type DatabaseKind = 'cell' | 'directory';

export const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:55432/postgres';

export function urlFor(baseUrl: string, database: string, user?: string, password?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}

// Creates the database if missing, then runs the bootstrap SQL inside it.
export async function bootstrapDatabase(adminUrl: string, database: string, kind: DatabaseKind): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error(`invalid database name: ${database}`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [database]);
    if (!rowCount) await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }

  const sql = await readFile(path.resolve(here, `../bootstrap/${kind}.bootstrap.sql`), 'utf8');
  const db = new pg.Client({ connectionString: urlFor(adminUrl, database) });
  await db.connect();
  try {
    await db.query(sql);
  } finally {
    await db.end();
  }
}

// One login per service for local development, password 'local', each a member of only
// the roles its service uses (database README, Roles), as a deployment gives each service.
export const LOCAL_SERVICE_LOGINS: Readonly<Record<string, readonly string[]>> = {
  svc_auth: ['silo_auth', 'silo_app'],
  svc_credential: ['silo_credential', 'silo_app'],
  svc_app: ['silo_app'],
  svc_audit: ['silo_audit_writer', 'silo_app'],
  svc_model_gateway: ['silo_audit_writer', 'silo_app'],
  svc_outbox_relay: ['silo_outbox_relay'],
  svc_maintenance: ['silo_migrate'],
  svc_billing: ['silo_billing', 'silo_app'],
  svc_directory: ['directory_writer'],
  svc_status: ['status_writer'],
  svc_fleet_control: ['fleet_writer'],
  svc_catalogue_migrate: ['silo_migrate'],
};

async function createLocalLogins(adminUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const [login, roles] of Object.entries(LOCAL_SERVICE_LOGINS)) {
      const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [login]);
      if (!rowCount) await admin.query(`create role ${login} login password 'local'`);
      for (const role of roles) await admin.query(`grant ${role} to ${login}`);
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const adminUrl = process.env['LOCAL_ADMIN_URL'] ?? DEFAULT_ADMIN_URL;
  await bootstrapDatabase(adminUrl, 'silo_cell', 'cell');
  await bootstrapDatabase(adminUrl, 'silo_directory', 'directory');
  await createLocalLogins(adminUrl);
  console.log(`Local service logins: ${Object.keys(LOCAL_SERVICE_LOGINS).join(', ')} (password 'local').`);
  console.log('Bootstrapped silo_cell and silo_directory. To migrate locally:');
  console.log(`  CELL_MIGRATE_URL=${urlFor(adminUrl, 'silo_cell')} npm run db:migrate`);
  console.log(`  DIRECTORY_MIGRATE_URL=${urlFor(adminUrl, 'silo_directory')} npm run db:migrate:directory`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
