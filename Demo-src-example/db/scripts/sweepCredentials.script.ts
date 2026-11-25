/**
 * Warn about credentials that are about to stop working.
 *
 * ── Why a script and not a route ───────────────────────────────────────────
 *
 * It reads across every organisation on the cell, which row level security
 * exists to prevent, so it connects as the migrator — the same reasoning as
 * `sweep:retention`. A cell-wide count on an endpoint would also let a member
 * difference two calls into a signal about other customers.
 *
 * ── Driven from outside the process ────────────────────────────────────────
 *
 * Daily, from Cloud Scheduler. Each warning goes out once per stage, so a run
 * missed or repeated changes nothing but when the next one lands.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { sweep } from '../../services/credentialExpiry.service';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Set DATABASE_URL (or DATABASE_MIGRATION_URL) before sweeping.');
    process.exitCode = 1;
    return;
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { warned, notified } = await sweep(client);
    await client.query('COMMIT');
    console.log(`  warned about ${warned} credential${warned === 1 ? '' : 's'}; ${notified} notification${notified === 1 ? '' : 's'} sent`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
