// Applies forward-only SQL migrations (spec 11.3: expand and contract, no down
// migrations). Each file runs in its own transaction as the migration role, and is
// recorded with a SHA-256 checksum. An applied file that has since changed, or an
// applied version whose file is missing, stops the run: migrations are history.
//
// Usage:
//   node src/db/scripts/migrate.script.ts cell        (uses CELL_MIGRATE_URL)
//   node src/db/scripts/migrate.script.ts directory   (uses DIRECTORY_MIGRATE_URL)
//
// The login in the URL must be a member of the migration role (silo_migrate or
// directory_migrate). The runner switches to that role with SET ROLE, because role
// attributes such as BYPASSRLS are not inherited through membership.
//
// Run by a cell's Fleet agent as a Job (spec 11.3), SILO_EXPECTED_MIGRATIONS names the
// release's migrations ([{version, name, digest: "sha256:<hex>"}]): the files in the image
// must be exactly those, byte for byte, or nothing is applied.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Target = 'cell' | 'directory';

interface TargetConfig {
  directory: string;
  role: string;
  ledgerSchema: string;
  envVar: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

const TARGETS: Record<Target, TargetConfig> = {
  cell: {
    directory: path.resolve(here, '../migrations'),
    role: 'silo_migrate',
    ledgerSchema: 'platform',
    envVar: 'CELL_MIGRATE_URL',
  },
  directory: {
    directory: path.resolve(here, '../directory/migrations'),
    role: 'directory_migrate',
    ledgerSchema: 'directory',
    envVar: 'DIRECTORY_MIGRATE_URL',
  },
};

// One migration run per database at a time.
const ADVISORY_LOCK_KEY = 0x51_10_0001;

// File names are <version><Name>.migration.sql, for example 0002AuditIndexes.migration.sql.
const FILE_PATTERN = /^(\d{4})([A-Z][A-Za-z0-9]*)\.migration\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new Error(`migration file name must look like 0002AuditIndexes.migration.sql: ${file}`);
    }
    const sql = await readFile(path.join(directory, file), 'utf8');
    files.push({
      version: match[1]!,
      name: match[2]!,
      file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const versions = new Set<string>();
  for (const m of files) {
    if (versions.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    versions.add(m.version);
  }
  return files;
}

export interface ExpectedMigration {
  version: string;
  name: string;
  digest: string;
}

/** The files are exactly the release's migrations, byte for byte; otherwise why not. */
export function checkExpected(migrations: readonly MigrationFile[], expected: readonly ExpectedMigration[]): string | undefined {
  const files = new Map(migrations.map((m) => [m.version, m]));
  for (const e of expected) {
    const file = files.get(e.version);
    if (file === undefined) return `migration ${e.version}${e.name} is in the release but not in the image`;
    if (file.name !== e.name || `sha256:${file.checksum}` !== e.digest) return `migration ${file.file} is not the release's ${e.version}${e.name}`;
  }
  const named = new Set(expected.map((e) => e.version));
  const extra = migrations.find((m) => !named.has(m.version));
  return extra === undefined ? undefined : `migration ${extra.file} is in the image but not in the release`;
}

export async function migrate(
  target: Target,
  connectionString: string,
  log: (line: string) => void = console.log,
  expected?: readonly ExpectedMigration[],
): Promise<string[]> {
  const config = TARGETS[target];
  const migrations = await loadMigrations(config.directory);
  if (expected !== undefined) {
    const mismatch = checkExpected(migrations, expected);
    if (mismatch !== undefined) throw new Error(`${mismatch}: nothing applied`);
  }
  const client = new pg.Client({ connectionString, application_name: `silo-migrate-${target}` });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`set role ${config.role}`);
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`create schema if not exists ${config.ledgerSchema}`);
    await client.query(`
      create table if not exists ${config.ledgerSchema}.schema_migrations (
        version    text primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now(),
        applied_by text not null default session_user
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      `select version, checksum from ${config.ledgerSchema}.schema_migrations order by version`,
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const onDisk = new Set(migrations.map((m) => m.version));

    for (const version of done.keys()) {
      if (!onDisk.has(version)) {
        throw new Error(`migration ${version} is recorded as applied but its file is missing`);
      }
    }

    for (const m of migrations) {
      const recorded = done.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) {
          throw new Error(
            `migration ${m.file} changed after it was applied; write a new migration instead`,
          );
        }
        continue;
      }
      log(`applying ${m.file}`);
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query(
          `insert into ${config.ledgerSchema}.schema_migrations (version, name, checksum) values ($1, $2, $3)`,
          [m.version, m.name, m.checksum],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`migration ${m.file} failed: ${message}`, { cause: error });
      }
      applied.push(m.file);
    }
    if (applied.length === 0) log('nothing to apply');
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock_all()').catch(() => undefined);
    await client.end();
  }
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target !== 'cell' && target !== 'directory') {
    console.error('usage: node src/db/scripts/migrate.script.ts <cell|directory>');
    process.exit(2);
  }
  const url = process.env[TARGETS[target].envVar];
  if (!url) {
    console.error(`${TARGETS[target].envVar} is not set`);
    process.exit(2);
  }
  const named = process.env['SILO_EXPECTED_MIGRATIONS'];
  await migrate(target, url, console.log, named === undefined ? undefined : JSON.parse(named) as ExpectedMigration[]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
