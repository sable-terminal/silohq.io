// The restore check (spec 12.5; D251): every pg-control table's row count kept with a backup, and
// a restored database compared with it table by table; and the purge ledger read back from
// object-backup, a moved organisation's purge receipt among its entries.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { closePool, createPool } from '../../src/infra/postgres.infra.ts';
import { objectKey } from '../../src/infra/objectStorage.infra.ts';
import { checkAgainst, ledgerSince, takeManifest } from '../../src/services/maintenance/restore.service.ts';
import { CELL_ID, createLocalCell, createOrganisation } from '../db/fixtures.helper.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';

let h: Harness;
let migrate: ReturnType<typeof createPool>;

before(async () => {
  h = await createHarness();
  const owner = await h.connect('test_migrate');
  await createLocalCell(owner);
  await owner.end();
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'expression-evaluator', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url('test_app'),
  });
  migrate = createPool({ ...config.postgres, controlUrl: h.url('test_migrate'), poolMax: 2 }, 'control', 'maintenance');
});

after(async () => {
  if (migrate !== undefined) await closePool(migrate);
  await h?.close();
});

describe('the restore check (spec 12.5)', () => {
  test('a manifest of every table\'s rows, kept in object-backup; a database checked against it, table by table', async () => {
    const store = createMemoryStore();
    const app = await h.connect('test_app');
    await createOrganisation(app, 'acme');
    const kept = await takeManifest(migrate, store);
    assert.match(kept.key, /^cell\/row-counts\/\d{4}-\d\d-\d\dT\d{6}\.\d{3}Z\.json$/);
    assert.ok(kept.tables > 250, `every table: ${kept.tables}`);
    const same = await checkAgainst(migrate, store, kept.key);
    assert.deepEqual([same.differing, same.matched], [[], same.tables], 'nothing changed since');
    // A row the backup did not hold: named, with both counts.
    await createOrganisation(app, 'globex');
    const after = await checkAgainst(migrate, store, kept.key);
    const organisations = after.differing.find((d) => d.table === 'iam.organisations');
    assert.ok(organisations !== undefined && organisations.restored === organisations.manifest! + 1, JSON.stringify(after.differing));
    await app.end();
  });

  test('the ledger since a restore point: the purge ledger\'s entries and moved organisations\' purge receipts, oldest first', async () => {
    const store = createMemoryStore();
    const organisationId = uuidv7();
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 12, minutes)).toISOString();
    const put = async (occurredAt: string, entry: object) => {
      const id = uuidv7();
      const parts = ['purge-ledger', occurredAt.slice(0, 4), occurredAt.slice(5, 7), occurredAt.slice(8, 10), `${occurredAt.replaceAll(':', '')}.${id}.json`];
      await store.put('backup', objectKey.cell(...parts), Buffer.from(JSON.stringify({ id, organisationId, occurredAt, correlationId: uuidv7(), entry })), 'application/json');
      return id;
    };
    await put(at(1), { kind: 'files', fileIds: [uuidv7()] });
    const later = await put(at(30), { kind: 'spatial', planId: uuidv7() });
    const migrationId = uuidv7();
    await store.put('backup', objectKey.cell('tenant-migrations', migrationId, 'purge-receipt.json'), Buffer.from(JSON.stringify({
      format: 'silo.tenant_purge_receipt.v1', migration_id: migrationId, organisation_id: organisationId, purged_at: at(20),
    })), 'application/json');
    const entries = await ledgerSince(store, at(10), new Date(at(59)));
    assert.deepEqual(entries.map((e) => [e.id, e.entry.kind]), [[migrationId, 'organisation'], [later, 'spatial']]);
    assert.deepEqual(entries[0]!.entry, { kind: 'organisation', migrationId });
  });
});

