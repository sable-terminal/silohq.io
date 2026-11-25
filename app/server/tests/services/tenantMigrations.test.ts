// Tenant migrations end to end (spec 6.4, 6.7): two cells, each with its own database,
// credential service (its own KEK) and object store, and the shared directory. The test
// plays the operator: it signs, schedules, and carries the bundle and the purge receipt
// from one cell's object-backup to the other's, which is the only way cells meet.
//
// What it shows: the rules of asking; Actions and Crons paused from the window; the
// export waits for the outbox; every table's rows arrive with matching counts and
// checksums; a value sealed under the organisation's data key in the source opens in the
// destination (the key moved, re-wrapped; credentials did not); connections are halted
// for re-authorisation; the directory routes to the destination; the source purges after
// 30 days with a receipt, and the receipt completes the migration.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { openRecordValues, sealRecordValues } from '../../src/contracts/credential/recordValue.contract.ts';
import { findOrganisation, registerCell, registerOrganisation } from '../../src/contracts/directory/registration.contract.ts';
import * as m from '../../src/contracts/tenant-migrations/migration.contract.ts';
import { objectKey } from '../../src/infra/objectStorage.infra.ts';
import { closePool, createPool, openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { tenantMigrationRepo } from '../../src/repos/platform/tenantMigration.repo.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createDirectoryService } from '../../src/routes/directory/index.route.ts';
import { createTenantMigrationsService } from '../../src/routes/tenant-migrations/index.route.ts';
import { bundleKey, purgeReceiptKey, WRITES_SETTLE_MS, type TenantMigrationsDeps } from '../../src/services/tenant-migrations/deps.service.ts';
import { createRequests } from '../../src/services/tenant-migrations/requests.service.ts';
import { createStages } from '../../src/services/tenant-migrations/stages.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, quiet, type ConnectCell, type Signed } from './connect.helper.ts';
import { createMemoryStore, type MemoryStore } from './memoryStore.helper.ts';

const DESTINATION = 'ded-acme';
const DAY = 86_400_000;
let clock = Date.parse('2026-11-04T09:00:00Z');
const now = () => new Date(clock);

let source: ConnectCell;
let root: Signed;
let dest: Harness;
let destMigrate: pg.Client;
let destApp: pg.Client;
const sourceStore: MemoryStore = createMemoryStore();
const destStore: MemoryStore = createMemoryStore();
const processes: RunningProcess[] = [];
const pools: Databases[] = [];
const migratePools: ReturnType<typeof createPool>[] = [];
const clients: ServiceClient[] = [];
let directoryUrl: string;
// A file larger than a bundle segment, which travels in chunks.
let bigFile: { key: ReturnType<typeof objectKey.organisation>; body: Buffer };
let destCredentialUrl: string;
let sourceSide: { deps: TenantMigrationsDeps; requests: ReturnType<typeof createRequests>; stages: ReturnType<typeof createStages> };
let destSide: typeof sourceSide;
let operator: string;
let connectionId: string;
let sealed: string;
const binding = { table: 'action.receipts', id: uuidv7() };

/** HTTP settings for a client, from a service with no requirements of its own. */
const http = (serviceUrls: Record<string, string>) => ({ ...env('expression-evaluator', {}).http, serviceUrls });

const env = (service: string, extra: Record<string, string>): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', ...extra,
});

function side(cellId: string, h: Harness, objects: MemoryStore, serviceUrls: Record<string, string>): typeof sourceSide {
  const config = env('expression-evaluator', { PG_CONTROL_URL: h.url('test_app') });
  const databases = openDatabases(config.postgres, 'tenant-migrations', ['control']);
  pools.push(databases);
  const migrate = createPool({ ...config.postgres, controlUrl: h.url('test_migrate'), poolMax: 2 }, 'control', 'tenant-migrations');
  migratePools.push(migrate);
  const services = createServiceClient({ caller: 'tenant-migrations', http: { ...config.http, serviceUrls } });
  clients.push(services);
  // Three rows per cursor fetch, so tables cross batches at both ends.
  const deps: TenantMigrationsDeps = { databases, migrate, objects, services, logger: quiet, cellId, directory: true, now, rowBatch: 3 };
  return { deps, requests: createRequests(deps), stages: createStages(deps) };
}

const cellRow = (db: pg.Client, id: string, kind: string, local: boolean) => db.query(
  `insert into platform.cells (id, kind, residency, location, hosting, hostname, is_local, status, placement_open)
   values ($1, $2, 'uk', 'London', 'gke', $3, $4, 'active', true) on conflict (id) do nothing`, [id, kind, `${id}.silohq.io`, local]);

const sourceSql = (text: string, values: unknown[] = []) => inTx(source.app, { orgId: source.org }, () => source.app.query(text, values));
const destSql = (text: string, values: unknown[] = []) => inTx(destApp, { orgId: source.org }, () => destApp.query(text, values));
const migration = async (side: typeof sourceSide, id: string) => (await side.requests.get({ request: { organisationId: source.org }, correlationId: id }, id));
const copy = async (key: ReturnType<typeof bundleKey>) => destStore.put('backup', key, await sourceStore.get('backup', key), 'application/octet-stream');

before(async () => {
  source = await createConnectCell();
  root = await source.signIn('root@acme.example');
  bigFile = { key: objectKey.organisation(source.org, 'files', uuidv7()), body: randomBytes(3 * 1024 * 1024 + 12_345) };
  dest = await createHarness();
  destMigrate = await dest.connect('test_migrate');
  destApp = await dest.connect('test_app');
  for (const db of [source.migrate, destMigrate]) {
    await cellRow(db, CELL_ID, 'commercial', db === source.migrate);
    await cellRow(db, DESTINATION, 'dedicated', db === destMigrate);
  }
  await destMigrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);

  // The directory, shared by every cell: the cells and the organisation registered.
  const directory = await runProcess([createDirectoryService()], env('directory', {
    PG_DIRECTORY_URL: source.h.url('test_dir_writer', 'directory'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
    KMS_DIRECTORY_KEY_URI: 'local:directory', DIRECTORY_PUBLIC_PORT: '0', DIRECTORY_PUBLIC_HOST: '127.0.0.1',
    DIRECTORY_PUBLIC_ORIGINS: 'https://silohq.io', DIRECTORY_PUBLIC_REQUESTS_PER_MINUTE: '60', TRUST_PROXY_HOPS: '0',
  }), { logger: quiet });
  processes.push(directory);
  directoryUrl = `http://127.0.0.1:${directory.port}`;
  const fleet = createServiceClient({ caller: 'fleet-control', http: http({ directory: directoryUrl }) });
  const auth = createServiceClient({ caller: 'auth', http: http({ directory: directoryUrl }) });
  clients.push(fleet, auth);
  for (const [id, kind] of [[CELL_ID, 'commercial'], [DESTINATION, 'dedicated']] as const) {
    await fleet.call(registerCell, { params: { cellId: id }, body: { kind, residency: 'uk', hostname: `${id}.silohq.io`, status: 'active' } });
  }
  await auth.call(registerOrganisation, { params: { organisationSlug: 'acme' }, body: { cellId: CELL_ID, status: 'active' } });

  // The destination's credential service: its own KEK, and the import key the source seals to.
  const destCredential = await runProcess([credentialService], env('credential', {
    SILO_CELL_ID: DESTINATION, SILO_CELL_KIND: 'dedicated', PG_CONTROL_URL: dest.url('test_credential'), KMS_PROVIDER: 'local',
    KMS_LOCAL_KEY: randomBytes(32).toString('base64'), KMS_IMPORT_KEY_URI: 'local:import', KMS_DIRECTORY_KEY_URI: 'local:directory',
  }), { logger: quiet });
  processes.push(destCredential);
  destCredentialUrl = `http://127.0.0.1:${destCredential.port}`;

  // The source's tenant-migrations, serving the customer's routes.
  await source.start(createTenantMigrationsService({ objects: sourceStore, now }), 'tenant-migrations', 'test_app', {
    MAINTENANCE_DATABASE_URL: source.h.url('test_migrate'), TENANT_MIGRATIONS_TICK_SECONDS: '3600', SERVICE_URL_DIRECTORY: directoryUrl,
    OBJECT_STORE: 's3', OBJECT_BUCKET_BACKUP: 'silo-test-backup', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
  });
  sourceSide = side(CELL_ID, source.h, sourceStore, { credential: `http://127.0.0.1:${source.ports.credential}`, directory: directoryUrl });
  destSide = side(DESTINATION, dest, destStore, { credential: destCredentialUrl, directory: directoryUrl });

  // What the organisation holds: a connection, a value sealed under its data key, a stored file.
  operator = uuidv7();
  for (const db of [source.migrate, destMigrate]) {
    await db.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident) values ($1, 'op', 'Op', 'sc', true)
                    on conflict (id) do nothing`, [operator]);
  }
  const [connector, manifest] = [uuidv7(), uuidv7()];
  connectionId = uuidv7();
  await sourceSql(`insert into connect.connectors (id, organisation_id, kind, slug, name, provider, trust_tier, source_route, author_organisation_id,
    created_by_membership_id) values ($1, $2, 'private', 'ledger', 'Ledger', 'example', 'private', 'ai', $2, $3)`, [connector, source.org, root.membershipId]);
  await sourceSql(`insert into connect.connector_manifests (id, organisation_id, connector_id, version, document, document_hash, schema_version,
    source_route, created_by_membership_id) values ($1, $2, $3, '1.0.0', '{}', $4, '1', 'ai', $5)`, [manifest, source.org, connector, Buffer.alloc(32), root.membershipId]);
  await sourceSql(`insert into connect.connections (id, organisation_id, connector_id, manifest_id, name, provider, trust_tier, owning_scope_id,
    owning_membership_id, created_by, status) values ($1, $2, $3, $4, 'Ledger', 'example', 'private', $5, $6, $6, 'active')`,
  [connectionId, source.org, connector, manifest, source.scopes['engineering'], root.membershipId]);
  const actions = source.client('actions');
  sealed = (await actions.call(sealRecordValues, { body: { items: [{ binding, value: Buffer.from('"hello"').toString('base64') }] } },
    { request: { organisationId: source.org } })).items[0]!;
  await sourceStore.put('files', objectKey.organisation(source.org, 'files', uuidv7()), Buffer.from('a file'), 'text/plain');
  await sourceStore.put('files', bigFile.key, bigFile.body, 'application/octet-stream');
});

after(async () => {
  for (const c of clients) c.close();
  for (const p of migratePools) await closePool(p);
  for (const d of pools) await d.close();
  for (const p of processes.reverse()) await p.stop('test');
  await dest?.close();
  await source?.close();
});

describe('tenant migrations (spec 6.4)', () => {
  test('the rules of asking: placement within the reason, one at a time, withdrawn before the window', async () => {
    const gateway = source.client('gateway');
    await assert.rejects(gateway.call(m.requestTenantMigration, { body: { destinationCellId: DESTINATION, reason: 'residency_change' } }, source.as(root)),
      { code: 'tenant_migrations.destination_refused' }, 'a residency change goes to another residency');
    const asked = await gateway.call(m.requestTenantMigration, { body: { destinationCellId: DESTINATION, reason: 'promotion_dedicated' } }, source.as(root));
    assert.deepEqual([asked.status, asked.side, asked.approvedByMembershipId], ['requested', 'source', root.membershipId]);
    await assert.rejects(gateway.call(m.requestTenantMigration, { body: { destinationCellId: DESTINATION, reason: 'promotion_dedicated' } }, source.as(root)),
      { code: 'tenant_migrations.already_live' });
    const withdrawn = await gateway.call(m.withdrawTenantMigration, { params: { migrationId: asked.id } }, source.as(root));
    assert.deepEqual([withdrawn.status, withdrawn.abortReason], ['aborted', 'withdrawn']);
    // A cell with no directory cannot move an organisation: nothing would route it.
    const alone = createRequests({ ...sourceSide.deps, directory: false });
    await assert.rejects(alone.request({ request: { organisationId: source.org, membershipId: root.membershipId }, correlationId: uuidv7() },
      { destinationCellId: DESTINATION, reason: 'promotion_dedicated' }), { code: 'tenant_migrations.no_directory' });
  });

  test('a migration from approval to completion, verified at both ends', async () => {
    const gateway = source.client('gateway');
    const asked = await gateway.call(m.requestTenantMigration, { body: { destinationCellId: DESTINATION, reason: 'promotion_dedicated' } }, source.as(root));
    const id = asked.id;
    const op = { operatorId: operator, organisationId: source.org };
    await assert.rejects(sourceSide.requests.sign(id, id, { ...op, role: 'security_officer' }), { code: 'tenant_migrations.not_needed' });
    assert.equal((await sourceSide.requests.sign(id, id, { ...op, role: 'contract' })).status, 'approved');

    const key = await destSide.requests.importKey(id);
    const scheduled = await sourceSide.requests.schedule(id, id, {
      ...op, windowStartsAt: new Date(clock + 60_000).toISOString(), windowEndsAt: new Date(clock + 4 * 3_600_000).toISOString(),
      destinationKey: key.publicKey, moveSiloes: true,
    });
    assert.equal(scheduled.status, 'scheduled');
    const paused = () => inTx(source.app, { orgId: source.org }, () => tenantMigrationRepo.writesPaused(source.app, source.org));
    assert.equal(await paused(), false, 'Actions and Crons run until the window');

    // The window opens: read-only, then the export waits for the outbox to empty.
    clock += 120_000;
    await sourceSide.stages.tick();
    assert.equal((await migration(sourceSide, id)).status, 'read_only');
    assert.equal(await paused(), true, 'Actions and Crons pause from the window');
    await source.migrate.query('update platform.outbox set published_at = now() where organisation_id = $1 and published_at is null', [source.org]);
    await sourceSide.stages.tick();
    assert.equal((await migration(sourceSide, id)).status, 'read_only', 'a write admitted before the window may still be running');
    clock += WRITES_SETTLE_MS;
    await sourceSide.stages.tick();
    const exported = await migration(sourceSide, id);
    assert.equal(exported.status, 'exporting');
    assert.ok(exported.exportCompletedAt !== null && exported.bundleChecksum !== null);
    assert.ok(exported.tables.length > 200, 'every table is counted');
    assert.ok(exported.tables.every((t) => t.sourceChecksum !== null && t.destinationChecksum === null));

    // The operator carries the bundle; the destination loads, verifies, re-wraps the keys,
    // halts connections and moves the directory.
    await copy(bundleKey(id));
    await destSide.stages.tick();
    const landed = await migration(destSide, id);
    assert.deepEqual([landed.side, landed.status, landed.connectionsPendingReauthorisation], ['destination', 'source_read_only', 1]);
    assert.ok(landed.tables.every((t) => t.matched === true && t.sourceChecksum === t.destinationChecksum), 'row counts and checksums match at both ends');
    assert.equal(landed.bundleChecksum, exported.bundleChecksum);
    const { rows: [org] } = await destSql('select cell_id from iam.organisations where id = $1', [source.org]);
    assert.equal(org.cell_id, DESTINATION);
    const { rows: [connection] } = await destSql('select status, halted_reason from connect.connections where id = $1', [connectionId]);
    assert.deepEqual([connection.status, connection.halted_reason], ['halted', 'tenant_migration']);
    assert.equal((await destSql('select count(*)::int as n from connect.connection_credentials')).rows[0].n, 0, 'credentials never move');
    assert.equal((await destMigrate.query('select count(*)::int as n from iam.users where email = $1', ['root@acme.example'])).rows[0].n, 1);
    assert.ok(destStore.keys('files').some((k) => k.startsWith(`org/${source.org}/files/`)), 'stored files move');
    assert.ok((await destStore.get('files', bigFile.key)).equals(bigFile.body), 'a file larger than a segment moves whole');
    assert.ok((await sourceStore.get('backup', bundleKey(id))).length > 3 * 1024 * 1024, 'the bundle spans several segments');
    const destActions = createServiceClient({ caller: 'actions', http: http({ credential: destCredentialUrl }) });
    clients.push(destActions);
    const opened = await destActions.call(openRecordValues, { body: { items: [{ binding, sealed }] } }, { request: { organisationId: source.org } });
    assert.equal(Buffer.from(opened.items[0]!, 'base64').toString(), '"hello"', 'a value sealed in the source opens here: its key moved, re-wrapped');
    const directory = createServiceClient({ caller: 'auth', http: http({ directory: directoryUrl }) });
    clients.push(directory);
    assert.equal((await directory.call(findOrganisation, { params: { organisationSlug: 'acme' } })).cellId, DESTINATION);

    // The source sees the directory moved, holds read-only for 30 days, then purges.
    await sourceSide.stages.tick();
    const holding = await migration(sourceSide, id);
    assert.equal(holding.status, 'source_read_only');
    assert.equal(Date.parse(holding.sourceReadOnlyUntil!), clock + 30 * DAY);
    clock += 29 * DAY;
    await sourceSide.stages.tick();
    assert.equal((await migration(sourceSide, id)).status, 'source_read_only', 'not before the 30 days are out');
    clock += 2 * DAY;
    await sourceSide.stages.tick();
    assert.equal((await source.migrate.query('select count(*)::int as n from iam.organisations where id = $1', [source.org])).rows[0].n, 0);
    assert.equal((await source.migrate.query('select count(*)::int as n from iam.memberships where organisation_id = $1', [source.org])).rows[0].n, 0);
    assert.equal((await source.migrate.query('select count(*)::int as n from iam.users where email = $1', ['root@acme.example'])).rows[0].n, 0);
    assert.ok(!sourceStore.keys('files').some((k) => k.startsWith(`org/${source.org}/`)), 'stored files purged');
    assert.equal(await sourceStore.head('backup', bundleKey(id)), undefined, 'the bundle goes with them');
    const receipt = JSON.parse((await sourceStore.get('backup', purgeReceiptKey(id))).toString()) as { migration_id: string; tables: unknown[] };
    assert.equal(receipt.migration_id, id);
    assert.ok(receipt.tables.length > 5);

    // The operator carries the receipt; the destination completes.
    await destStore.put('backup', purgeReceiptKey(id), await sourceStore.get('backup', purgeReceiptKey(id)), 'application/json');
    await destSide.stages.tick();
    const done = await migration(destSide, id);
    assert.deepEqual([done.status, done.sourcePurgedAt !== null], ['completed', true]);
    const events = (await destSql(`select payload ->> 'event' as event, payload -> 'detail' as detail from platform.outbox where organisation_id = $1`,
      [source.org])).rows as { event: string; detail: Record<string, unknown> }[];
    const completed = events.find((e) => e.event === 'tenant_migration_completed')!;
    assert.equal(completed.detail['source_rows'], completed.detail['destination_rows']);
    assert.equal(completed.detail['bundle_checksum'], exported.bundleChecksum);
    assert.ok(events.some((e) => e.event === 'tenant_source_purged'));
    const entry = events.find((e) => e.event === 'directory_entry_changed')!;
    assert.deepEqual([entry.detail['change'], entry.detail['from_cell_id'], entry.detail['to_cell_id']], ['moved', done.sourceCellId, DESTINATION],
      'the directory now routes the organisation here (6.7)');

    // A bundle seen again is left alone.
    assert.equal((await destSide.stages.tick()).loaded, 0);
  });
});
