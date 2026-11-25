/**
 * Import §2 — pick up from every watched location that is due.
 *
 * ── Two roles, as the recovery script uses ─────────────────────────────────
 *
 * The migrator, BYPASSRLS, only to find which locations are due across the
 * cell. Each pickup then runs through the service as the application, under
 * its own organisation's tenant context, and opens its credential through the
 * mediator, which audits the access.
 *
 * ── Waits for what it queued ───────────────────────────────────────────────
 *
 * Received files are structured by the in-process queue, and this process is
 * that queue's only owner. It waits for the queue to settle before it exits, or
 * every file it picked up would be stranded for `silo:process` to find.
 *
 * Driven from outside the process on a schedule: `npm run silo:watch`.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as siloImportRepo from '../../repos/siloImport.repo';
import * as siloWatch from '../../services/siloWatch.service';
import * as siloImport from '../../services/siloImport.service';

/* A little under the schedule, so a pickup that ran long is not skipped next time. */
const DUE_AFTER_MINUTES = 10;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding due locations is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  let due: Array<{ id: string; organisationId: string }>;
  try {
    due = await siloImportRepo.dueWatchedSources(client, DUE_AFTER_MINUTES);
  } finally {
    await client.end();
  }

  const outcomes: Record<string, number> = {};
  let picked = 0;

  for (const source of due) {
    const outcome = await siloWatch.poll(source.organisationId, source.id);
    const key = outcome.status === 'failed' ? outcome.failureCode : outcome.status;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (outcome.status === 'polled') picked += outcome.picked;
  }

  await siloImport.settled();

  console.log(`  ${due.length} watched location${due.length === 1 ? '' : 's'}, ${picked} picked up: ${JSON.stringify(outcomes)}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Watched pickup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
