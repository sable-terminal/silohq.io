/**
 * Billing §3 — roll every subscription whose period has ended.
 *
 * ── What a boundary does ───────────────────────────────────────────────────
 *
 * A seat released mid-period stops being billed here and not before; the period
 * moves on; the entitlements for the new period are written from what the
 * subscription says now. Nothing is charged: what a period costs is Stripe's.
 *
 * ── Driven from outside the process ────────────────────────────────────────
 *
 * Cloud Run scales to zero, so a boundary that relied on an instance being
 * awake would pass silently and bill last month's seat count again.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as billing from '../../services/billing.service';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding subscriptions to roll is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  let due: Array<{ id: string; organisationId: string }>;
  try {
    due = await billing.dueToRoll(client as never);
  } finally {
    await client.end();
  }

  let rolled = 0;
  for (const subscription of due) {
    if ((await billing.rollPeriod(subscription.organisationId)) === 'rolled') rolled += 1;
  }

  console.log(`  ${due.length} subscription${due.length === 1 ? '' : 's'} due; rolled ${rolled}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Billing roll failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
