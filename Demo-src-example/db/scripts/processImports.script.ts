/**
 * Import — structure received files nothing has structured.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Files are structured by an in-process queue after their receipt is
 * confirmed. An instance that dies with the queue full, or mid-way through a
 * file, leaves files `received` or `processing` that nothing will return to.
 * This finds them and runs them, and processing is idempotent — a file's earlier
 * rows are removed before its rows are written — so running one twice is safe.
 *
 * ── Two roles ───────────────────────────────────────────────────────────────
 *
 * The migrator, BYPASSRLS, only to find stranded files across the cell. Each file
 * is then processed through the service as the application, under its own
 * organisation's tenant context, exactly as the queue would have.
 *
 * Driven from outside the process, like the retention sweep: `npm run silo:process`.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as siloImportRepo from '../../repos/siloImport.repo';
import * as siloImport from '../../services/siloImport.service';

/* Long enough that a file still in the queue of a live instance is left to it. */
const STRANDED_AFTER_MINUTES = 10;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding stranded files is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  let stranded: siloImportRepo.SiloFile[];
  try {
    stranded = await siloImportRepo.strandedFiles(client, STRANDED_AFTER_MINUTES);
    /* A claim older than this belongs to an instance that is gone. */
    for (const file of stranded) {
      if (file.status === 'processing') await siloImportRepo.releaseClaim(client, file.id);
    }
  } finally {
    await client.end();
  }

  const outcomes: Record<string, number> = {};
  for (const file of stranded) {
    const outcome = await siloImport.processFile(file.organisationId, file.id);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }

  console.log(`  ${stranded.length} stranded file${stranded.length === 1 ? '' : 's'}: ${JSON.stringify(outcomes)}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Import processing failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
