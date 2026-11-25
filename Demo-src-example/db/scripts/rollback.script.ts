import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, ensureLedger, LEDGER, loadMigrations, MIGRATIONS_DIR } from './migrate.script';

/**
 * Undo the most recent migration.
 *
 * ONE AT A TIME, AND ONLY THE LAST. A runner that takes "roll back to 003" is a
 * runner somebody uses to drop four tables in production while meaning to drop
 * one. If several need undoing, run it several times and read what it says each
 * time.
 *
 * IT REFUSES WHEN THERE IS NO ROLLBACK FILE rather than marking the migration
 * undone. A ledger that says a migration is not applied when its tables are
 * still there is worse than a failed command.
 */
async function rollback(): Promise<void> {
  const client = await connect();

  try {
    await ensureLedger(client);

    const { rows } = await client.query<{ version: string; name: string }>(
      `SELECT version, name FROM ${LEDGER} ORDER BY version DESC LIMIT 1`,
    );
    const last = rows[0];

    if (!last) {
      console.log('  nothing to roll back');
      return;
    }

    const migration = loadMigrations().find((m) => m.version === last.version);
    if (!migration) {
      throw new Error(
        `${last.version}_${last.name} is in the ledger but its file is gone. ` +
          `Restore the file before rolling back.`,
      );
    }

    const file = migration.filename.replace(/\.sql$/, '.rollback.sql');
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    } catch {
      throw new Error(`${file} does not exist, so ${migration.filename} cannot be undone.`);
    }

    process.stdout.write(`  rolling back ${migration.filename} … `);

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`DELETE FROM ${LEDGER} WHERE version = $1`, [last.version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      process.stdout.write('failed\n');
      throw error;
    }

    process.stdout.write('ok\n');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  rollback()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(`\nRollback failed: ${(error as Error).message}`);
      process.exit(1);
    });
}
