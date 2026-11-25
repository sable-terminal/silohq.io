/**
 * Automations §7 — run everything whose schedule has come round.
 *
 * ── Driven from outside the process ────────────────────────────────────────
 *
 * Cloud Run scales to zero, so a schedule that relied on an instance being
 * awake would simply not fire. The scheduler wakes this, it takes whatever is
 * due, and it exits.
 *
 * ── §15.3: a suspended account's crons are paused ─────────────────────────
 *
 * Enforced here rather than at the door. A suspended customer can still read
 * what their checks are and that they are not running; what stops is the
 * running. Cancellation stops them too, by the same rule.
 *
 * ── One automation's failure is not everybody's ───────────────────────────
 *
 * Each is run on its own, and a throw is recorded against that automation
 * rather than ending the sweep. A single customer's halted connection must not
 * stop every other organisation's checks that night.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as automation from '../../services/automation.service';
import { capabilitiesFor } from '../../models/organisation.model';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding what is due is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  let due: Array<{ id: string; organisationId: string }>;
  let billing: Map<string, string>;

  try {
    due = await automation.due(client as never);

    const { rows } = await client.query<{ id: string; billing_status: string }>(
      `SELECT id, billing_status FROM organisations WHERE id = ANY($1)`,
      [[...new Set(due.map((one) => one.organisationId))]],
    );
    billing = new Map(rows.map((row) => [row.id, row.billing_status]));
  } finally {
    await client.end();
  }

  const counts = { met: 0, not_met: 0, skipped: 0, failed: 0, paused_by_billing: 0 };

  for (const item of due) {
    const status = billing.get(item.organisationId) ?? 'cancelled';
    if (!capabilitiesFor(status as never).cronsRun) {
      counts.paused_by_billing += 1;
      continue;
    }

    try {
      counts[await automation.runOne(item)] += 1;
    } catch (error: unknown) {
      counts.failed += 1;
      console.error(`  ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `  ${due.length} due; ${counts.met} fired, ${counts.not_met} quiet, ` +
      `${counts.skipped} skipped, ${counts.failed} failed, ${counts.paused_by_billing} held by billing`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Automation sweep failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
