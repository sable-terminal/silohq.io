/**
 * Billing §6 — read what every Silo holds and has scanned, and price it.
 *
 * ── Measured, then charged; never the other way round ──────────────────────
 *
 * The bytes come from the stores themselves and the provider's cost is recorded
 * beside them. Nothing here charges anybody: it writes down what happened, which
 * is what the statement and, later, the invoice are drawn from.
 *
 * ── Run often, charge once ─────────────────────────────────────────────────
 *
 * Storage is a level, so a reading taken today replaces today's for the month it
 * falls in. Bytes scanned are a difference from the last reading, so running
 * this twice in a day does not bill the same terabyte twice.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as storageBilling from '../../services/storageBilling.service';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error('Set DATABASE_MIGRATION_URL: finding organisations to measure is cross-tenant.');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  let organisations: string[];
  try {
    organisations = await storageBilling.organisationsWithSiloes(client as never);
  } finally {
    await client.end();
  }

  let siloes = 0;
  for (const organisationId of organisations) {
    /*
     * ONE ORGANISATION'S FAILURE IS NOT EVERYBODY'S. A Silo whose row store is
     * unreachable should cost the others their measurement for the month.
     */
    try {
      siloes += (await storageBilling.measure(organisationId)).siloes;
    } catch (error: unknown) {
      console.error(`  ${organisationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`  ${organisations.length} organisation${organisations.length === 1 ? '' : 's'}; ${siloes} silo${siloes === 1 ? '' : 'es'} measured`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Storage measurement failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
