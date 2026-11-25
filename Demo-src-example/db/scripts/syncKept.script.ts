/**
 * Siloes (135) — make today's copy of every concept somebody chose to keep.
 *
 * ── Two roles, as the other scheduled scripts use ─────────────────────────
 *
 * The migrator, BYPASSRLS, only to find which kept concepts are due across the
 * cell. Each copy then runs through the service as the application, under its
 * own organisation, as the person who asked for it to be kept — with their
 * reach and no more.
 *
 * NOTHING HERE DECIDES WHAT IS KEPT. An organisation that keeps nothing is not
 * found, and none of its systems are read.
 *
 * Driven from outside the process on a schedule: `npm run silo:sync`.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as holdingRepo from '../../repos/siloHolding.repo';
import * as siloKeep from '../../services/siloKeep.service';
import * as siloSync from '../../services/siloSync.service';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding what is due is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  let due: Awaited<ReturnType<typeof holdingRepo.dueConcepts>>;
  try {
    due = await holdingRepo.dueConcepts(client, siloKeep.SYNC_EVERY);
  } finally {
    await client.end();
  }

  const outcomes: Record<string, number> = {};

  for (const one of due) {
    try {
      const systems = await siloSync.copyAs(one);
      for (const system of systems) outcomes[system.state] = (outcomes[system.state] ?? 0) + 1;
    } catch (error) {
      outcomes.refused = (outcomes.refused ?? 0) + 1;
      console.error(`  ${one.conceptId}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`  ${due.length} kept concept${due.length === 1 ? '' : 's'} due: ${JSON.stringify(outcomes)}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Copying kept concepts failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
