/**
 * Mutations — pick up changes an instance stopped running.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A change is run after the request that approved it has returned. Cloud Run
 * can take that instance away mid-run, and a change half written with nothing
 * running it is the worst state the path has. So a scheduler calls this: any
 * run whose claim has gone quiet is taken over and resumed, record by record,
 * and any canary nobody confirmed or halted within a day is stopped where it is,
 * with its receipt.
 *
 * ── Cross-tenant to find, tenant-scoped to run ─────────────────────────────
 *
 * Finding stranded runs reads every organisation, so it connects as the
 * migrator. Running one goes through the service, under that organisation and
 * the proposer's grants, exactly as the original run did.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as executionRepo from '../../repos/mutationExecution.repo';
import * as execution from '../../services/mutationExecution.service';

/* Longer than a batch can take, so a run that is merely slow is not taken over. */
const STRANDED_AFTER_MINUTES = 10;
const CANARY_WAITS_HOURS = 24;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding stranded changes is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  const resume: Array<{ id: string; organisationId: string }> = [];
  const expire: Array<{ id: string; organisationId: string }> = [];

  try {
    const found = await executionRepo.stranded(client, {
      runningMinutes: STRANDED_AFTER_MINUTES,
      pausedHours: CANARY_WAITS_HOURS,
    });

    for (const one of found) {
      if (one.status === 'canary_paused') expire.push(one);
      else if (await executionRepo.reclaim(client, { id: one.id, minutes: STRANDED_AFTER_MINUTES })) resume.push(one);
    }
  } finally {
    await client.end();
  }

  const outcomes: Record<string, number> = {};
  for (const one of resume) {
    const outcome = await execution.run(one.organisationId, one.id);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  for (const one of expire) {
    await execution.expireCanary(one.organisationId, one.id);
  }

  console.log(`  resumed ${resume.length}: ${JSON.stringify(outcomes)}; canaries stopped ${expire.length}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Mutation pickup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
