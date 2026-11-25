/**
 * The `.env` file, but not the app's config.
 *
 * SELF-CONTAINED IS ABOUT `env.config`, NOT ABOUT `.env`. This deliberately does
 * not import the application's configuration — it has to run against a database
 * on a machine where the rest of the app may not be wired. It should still read
 * the same file every other command reads.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Forward migration runner.
 *
 * THE SAME RUNNER AS THE CONSOLE'S, WITH TWO THINGS CHANGED, AND BOTH MATTER
 * BECAUSE THE TWO SERVICES SHARE ONE DATABASE:
 *
 *   ITS LEDGER IS `schema_migrations`. This database has one owner. Sharing would
 *   mean this runner's 001 and the console's 001 are the same row. The first to
 *   run would record a version the second then believes it has already applied,
 *   and the schema that never got created would be discovered by a query failing
 *   in production.
 *
 *   ITS ADVISORY LOCK KEY IS DIFFERENT. Sharing one would serialise two
 *   unrelated deploys behind each other for no reason.
 *
 * WHAT IT GUARANTEES, unchanged from the console's:
 *
 *   ONE RUNNER AT A TIME, by a session-level advisory lock, so two deploys
 *   landing together cannot both apply the same file — which does not fail
 *   cleanly, it fails as half a schema.
 *
 *   APPLIED MIGRATIONS ARE IMMUTABLE. Every file's sha256 is recorded, and a
 *   file that has changed since it was applied stops the run. Editing an applied
 *   migration is the mistake that makes two environments disagree while both
 *   report success.
 *
 *   EACH FILE IN ITS OWN TRANSACTION, so a failure leaves the schema at a
 *   version rather than between two. A file needing to opt out says so with
 *   `-- migrate:no-transaction`.
 */

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const NO_TX_MARKER = 'migrate:no-transaction';

export const LEDGER = 'schema_migrations';

/**
 * A constant, not a hash of anything, and deliberately not the console's.
 *
 * Advisory lock keys are a single global namespace per database. Deriving one
 * from a string risks colliding with a key some other tool picked the same way,
 * and the failure — two processes believing they hold different locks — is
 * indistinguishable from no lock at all.
 */
const ADVISORY_LOCK_KEY = 8_140_2602;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  useTransaction: boolean;
}

export function loadMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql'))
    .sort();

  return files.map((filename) => {
    const [, version, name] = /^(\d+)_(.+)\.sql$/.exec(filename) ?? [];
    if (version === undefined || name === undefined) {
      throw new Error(`Migration filename not in NNN_name.sql form: ${filename}`);
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    return {
      version,
      name,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      useTransaction: !sql.includes(NO_TX_MARKER),
    };
  });
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Set DATABASE_MIGRATION_URL (or DATABASE_URL) to the product database.');
  }
  return url;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  // A migration is allowed to take as long as it takes. The defaults exist to
  // stop a runaway request, and this is not a request.
  await client.query('SET statement_timeout = 0');
  await client.query('SET idle_in_transaction_session_timeout = 0');
  await client.query('SET lock_timeout = 0');
  return client;
}

export async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER} (
      version     text        PRIMARY KEY,
      name        text        NOT NULL,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applied(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ version: string; checksum: string }>(
    `SELECT version, checksum FROM ${LEDGER} ORDER BY version`,
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

export async function runMigrations(): Promise<string[]> {
  const client = await connect();
  const ran: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureLedger(client);

    const already = await applied(client);

    for (const m of loadMigrations()) {
      const existing = already.get(m.version);

      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new Error(
            `${m.filename} has changed since it was applied. Applied migrations are ` +
              `immutable — add a new migration rather than editing this one.`,
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${m.filename} … `);

      if (m.useTransaction) {
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query(
            `INSERT INTO ${LEDGER} (version, name, checksum) VALUES ($1, $2, $3)`,
            [m.version, m.name, m.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          process.stdout.write('failed\n');
          throw error;
        }
      } else {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO ${LEDGER} (version, name, checksum) VALUES ($1, $2, $3)`,
          [m.version, m.name, m.checksum],
        );
      }

      process.stdout.write('ok\n');
      ran.push(m.filename);
    }

    console.log(ran.length === 0 ? '  nothing to apply' : `  applied ${ran.length} migration(s)`);
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {
      /* best effort: the lock dies with the session anyway */
    });
    await client.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(`\nMigration failed: ${(error as Error).message}`);
      process.exit(1);
    });
}
