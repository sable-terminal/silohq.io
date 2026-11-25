// The maintenance service on a fresh cell database, as a real process with its own
// migration login: partitions kept ahead and defaults emptied, closed ledger partitions
// sealed, partitions past retention dropped only when their seal still matches, outbox
// partitions dropped only when settled, and the expiry sweeps.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { ConfigError, loadConfig, type Env } from '../../src/config/index.config.ts';
import { maintenanceStatus } from '../../src/contracts/maintenance/status.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { service as maintenanceService } from '../../src/routes/maintenance/index.route.ts';
import { appendToChain } from '../../src/services/audit/chain.service.ts';
import { PartitionSeal, rowDigest } from '../../src/utils/auditChain.util.ts';
import { CELL_ID, createLocalCell, createMembership, createOrganisation, createUser } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';

const logs: string[] = [];
const capture = createLogger({ service: 'maintenance', cell: CELL_ID, release: 'test', level: 'info', write: (line) => { logs.push(line); } });

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let audit: pg.Client;
let process_: RunningProcess;
let client: ServiceClient;
let org: string;
let user: string;
let membership: string;
const ids: Record<string, string> = {};

const base = (extra: Env = {}): Env => ({
  SILO_ENV: 'test', SILO_SERVICE: 'maintenance', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
  SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', ...extra,
});

const exists = async (table: string): Promise<boolean> => (await migrate.query('select to_regclass($1) is not null as e', [table])).rows[0].e;
const seal = async (partition: string) => (await migrate.query('select * from audit.partition_seals where partition_name = $1', [partition])).rows[0];

async function authEvent(occurredAt: string): Promise<void> {
  await inTx(audit, { orgId: org }, () => audit.query(
    `insert into audit.auth_events (occurred_at, organisation_id, user_id, event, detail) values ($1, $2, $3, 'login', '{}')`,
    [occurredAt, org, user]));
}

async function chained(occurredAt: string, retentionClass: 'standard' | 'high_volume'): Promise<void> {
  await inTx(audit, { orgId: org }, () => appendToChain(audit, org, {
    sourceEventId: uuidv7(), occurredAt, retentionClass, event: retentionClass === 'standard' ? 'tenant_placed' : 'query_executed',
    membershipId: membership, servicePrincipalId: null, operatorId: null, systemService: null, subjectMembershipId: null, scopeId: null,
    resourceType: null, resourceId: null, purposeSessionId: null, operatorAccessSessionId: null, correlationId: uuidv7(), detail: {}, ipHash: null,
  }));
}

async function outboxRow(createdAt: string, published: boolean): Promise<void> {
  await inTx(app, { orgId: org }, () => app.query(
    `insert into platform.outbox (id, organisation_id, topic, ordering_key, event, payload, correlation_id, created_at, published_at)
     values ($1, $2, 'audit.events', $3, 'auth_event', '{}', $4, $5, $6)`,
    [uuidv7(), org, org, uuidv7(), createdAt, published ? createdAt : null]));
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  audit = await h.connect('test_audit');
  await createLocalCell(migrate);
  org = await createOrganisation(app, 'acme');
  user = await createUser(auth, 'someone@acme.example');
  membership = await createMembership(app, org, user);

  // Ledger rows: far ahead (into a default partition), long past retention, closed but kept.
  await authEvent('2031-03-04T10:00:00Z');
  for (const day of ['10', '11', '12']) await authEvent(`2025-01-${day}T09:00:00.123456Z`);
  for (const day of ['02', '03']) await authEvent(`2026-08-${day}T09:00:00Z`);
  await authEvent('2025-03-05T09:00:00Z');
  for (const day of ['10', '11']) await authEvent(`2025-02-${day}T09:00:00Z`);
  // A planted seal that does not match its partition: retention must refuse to drop it.
  await migrate.query('select platform.maintain_partitions()');
  await migrate.query(
    `insert into audit.partition_seals (id, ledger, partition_name, range_start, range_end, row_count, running_hash)
     values ($1, 'audit.auth_events', 'auth_events_y2025m03', '2025-03-01Z', '2025-04-01Z', 1, $2)`, [uuidv7(), Buffer.alloc(32)]);
  // A seal over the two rows a partition held, then a third loaded later with a later id,
  // as a tenant migration loads another cell's rows (spec 6.4): the seal still matches.
  const sealed = new PartitionSeal();
  for (const r of (await migrate.query('select * from audit.auth_events_y2025m02 order by id')).rows) sealed.add(rowDigest(r));
  await migrate.query(
    `insert into audit.partition_seals (id, ledger, partition_name, range_start, range_end, row_count, running_hash)
     values ($1, 'audit.auth_events', 'auth_events_y2025m02', '2025-02-01Z', '2025-03-01Z', 2, $2)`, [uuidv7(), sealed.runningHash]);
  await authEvent('2025-02-12T09:00:00Z');
  // Chained events: high volume past 400 days, standard within the 12 months set below.
  await chained('2025-08-15T00:00:00Z', 'high_volume');
  await chained('2025-12-15T00:00:00Z', 'standard');
  // Outbox: settled and 20 days old (dropped); unsettled and 18 days old (kept, alerting).
  await outboxRow(daysAgo(20), true);
  await outboxRow(daysAgo(18), false);

  // Sweeps.
  ids['oldReset'] = uuidv7();
  ids['newReset'] = uuidv7();
  await inTx(auth, { userId: user }, async () => {
    for (const [id, expired] of [[ids['oldReset'], 40], [ids['newReset'], 10]] as const) {
      await auth.query('insert into iam.password_resets (id, user_id, token_hash, created_at, expires_at) values ($1, $2, $3, $4, $5)',
        [id, user, randomBytes(32), daysAgo(expired + 1), daysAgo(expired)]);
    }
    ids['oldSession'] = uuidv7();
    ids['newSession'] = uuidv7();
    for (const [id, expired] of [[ids['oldSession'], 40], [ids['newSession'], 1]] as const) {
      await auth.query(
        `insert into iam.sessions (id, token_hash, user_id, issued_at, expires_at, auth_method) values ($1, $2, $3, $4, $5, 'password')`,
        [id, randomBytes(32), user, daysAgo(expired + 1), daysAgo(expired)]);
    }
  });
  const { rows } = await inTx(app, { orgId: org }, () => app.query(`select id from iam.roles where organisation_id = $1 and name = 'Member'`, [org]));
  ids['expiredInvitation'] = uuidv7();
  ids['openInvitation'] = uuidv7();
  await inTx(app, { orgId: org }, async () => {
    for (const [id, email, expires] of [
      [ids['expiredInvitation'], 'late@acme.example', daysAgo(1)], [ids['openInvitation'], 'soon@acme.example', new Date(Date.now() + 86_400_000).toISOString()],
    ] as const) {
      await app.query(
        `insert into iam.invitations (id, organisation_id, email, token_hash, role_id, invited_by, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, org, email, randomBytes(32), rows[0].id, membership, daysAgo(8), expires]);
    }
  });

  // OAuth flows: one used and settled long ago, holding the old session; one abandoned
  // yesterday; one still in flight. Written with foreign keys off (as the cluster
  // administrator), so the test needs no connector, manifest and connection behind them.
  const admin = new pg.Client({ connectionString: urlFor(process.env['TEST_PG_ADMIN_URL'] ?? DEFAULT_ADMIN_URL, h.cell) });
  await admin.connect();
  try {
    await admin.query(`set session_replication_role = replica`);
    for (const [name, session, created, expires, consumed] of [
      ['settledFlow', ids['oldSession'], daysAgo(41), daysAgo(40), daysAgo(41)],
      ['abandonedFlow', ids['newSession'], daysAgo(2), daysAgo(1), null],
      ['liveFlow', ids['newSession'], daysAgo(0), new Date(Date.now() + 600_000).toISOString(), null],
    ] as const) {
      ids[name] = randomBytes(32).toString('hex');
      await admin.query(
        `insert into connect.oauth_pending_flows (state_hash, organisation_id, connection_id, connector_id, membership_id, session_id,
           pkce_verifier_sealed, created_at, expires_at, consumed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [Buffer.from(ids[name]!, 'hex'), org, uuidv7(), uuidv7(), membership, session, randomBytes(48), created, expires, consumed]);
    }
    // Expiries the workspace, policy, the state plane and approvals leave to maintenance:
    // one past its time and one not, of each.
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    for (const [name, expires] of [['expiredShare', daysAgo(1)], ['liveShare', soon]] as const) {
      ids[name] = uuidv7();
      await admin.query(
        `insert into workspace.view_shares (id, organisation_id, saved_view_id, membership_id, access, shared_by, expires_at)
         values ($1, $2, $3, $4, 'view', $4, $5)`, [ids[name], org, uuidv7(), membership, expires]);
    }
    for (const [name, expires] of [['expiredPurpose', daysAgo(1)], ['livePurpose', soon]] as const) {
      ids[name] = uuidv7();
      await admin.query(
        `insert into gov.purpose_sessions (id, organisation_id, membership_id, session_id, purpose_definition_id, declared_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`, [ids[name], org, membership, ids['newSession'], uuidv7(), daysAgo(2), expires]);
    }
    for (const [name, expires] of [['expiredClient', daysAgo(1)], ['liveClient', soon]] as const) {
      ids[name] = uuidv7();
      await admin.query(
        `insert into iam.service_principals (id, organisation_id, kind, name, secret_hash, owner_membership_id, created_by, expires_at, created_at)
         values ($1, $2, 'api_client', $3, $4, $5, $5, $6, $7)`, [ids[name], org, name, Buffer.alloc(32, 1), membership, expires, daysAgo(2)]);
    }
    for (const [name, heartbeat] of [['lapsedLive', daysAgo(0.01)], ['heldLive', new Date().toISOString()]] as const) {
      ids[name] = uuidv7();
      await admin.query(
        `insert into clone.live_subscriptions (id, organisation_id, holder_kind, membership_id, session_id, object_set_ref, property_ids,
           projection_hash, object_count, connection_ids, state_plane_node, last_heartbeat_at)
         values ($1, $2, 'session', $3, $4, $5, '{}', 'h', 0, '{}', 'node', $6)`, [ids[name], org, membership, ids['newSession'], uuidv7(), heartbeat]);
    }
    for (const [name, expires] of [['expiredChain', daysAgo(1)], ['openChain', soon]] as const) {
      ids[name] = uuidv7();
      await admin.query(
        `insert into action.approval_chains (id, organisation_id, subject_kind, purge_request_id, requester_membership_id, policy_snapshot,
           approvals_required, created_at, expires_at) values ($1, $2, 'purge', $3, $4, '{"conditions": []}', 1, $5, $6)`,
        [ids[name], org, uuidv7(), membership, daysAgo(2), expires]);
    }
  } finally {
    await admin.end();
  }

  const config = loadConfig(base({
    MAINTENANCE_DATABASE_URL: h.url('test_migrate'), AUDIT_RETENTION_MONTHS: '12', MAINTENANCE_INTERVAL_SECONDS: '86400',
  }));
  process_ = await runProcess([maintenanceService], config, { logger: capture });
  client = createServiceClient({ caller: 'status', http: { ...config.http, serviceUrls: { maintenance: `http://127.0.0.1:${process_.port}` } } });
  // The jobs run once at start.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await client.call(maintenanceStatus, {});
    if (status.jobs.every((j) => j.outcome !== 'never')) break;
    if (Date.now() > deadline) throw new Error('the maintenance jobs did not run');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  client?.close();
  await process_?.stop('test');
  await h?.close();
});

describe('the migration login stays out of request-serving pods (spec 11.3)', () => {
  test('refused beside any service but the platform workers', () => {
    const url = 'postgres://svc_maintenance:x@127.0.0.1:5432/cell';
    assert.throws(() => loadConfig(base({ SILO_SERVICES: 'maintenance,audit', MAINTENANCE_DATABASE_URL: url, PG_CONTROL_URL: url.replace('maintenance', 'audit'), DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: 'nats://127.0.0.1:4222' })),
      (e: unknown) => e instanceof ConfigError && e.problems.some((p) => p.startsWith('MAINTENANCE_DATABASE_URL: only the platform workers')));
    assert.throws(() => loadConfig(base({})), (e: unknown) => e instanceof ConfigError && e.problems.includes('MAINTENANCE_DATABASE_URL: required by maintenance'));
    assert.doesNotThrow(() => loadConfig(base({
      SILO_SERVICES: 'maintenance,tenant-migrations', MAINTENANCE_DATABASE_URL: url, PG_CONTROL_URL: url.replace('maintenance', 'tenant'),
      OBJECT_STORE: 's3', OBJECT_BUCKET_BACKUP: 'backup', OBJECT_BUCKET_FILES: 'files', S3_REGION: 'eu-west-2', SERVICE_URL_DIRECTORY: 'http://127.0.0.1:1',
    })));
  });
});

describe('partitions (database README)', () => {
  test('every job ran and succeeded; every planned table is healthy', async () => {
    const status = await client.call(maintenanceStatus, {});
    assert.deepEqual(status.jobs.map((j) => [j.name, j.outcome, j.behind]), [
      ['partitions', 'ok', false], ['seals', 'ok', false], ['retention', 'ok', false], ['sweeps', 'ok', false]]);
    assert.deepEqual(status.unhealthyPartitions, []);
  });

  test('a row in a default partition moved to a partition of its own', async () => {
    assert.ok(await exists('audit.auth_events_y2031m03'));
    assert.equal(Number((await migrate.query('select count(*) as n from audit.auth_events_default')).rows[0].n), 0);
  });
});

describe('seals and retention (design: audit.partition_seals)', () => {
  test('a closed partition is sealed with its row count and running hash', async () => {
    const row = await seal('auth_events_y2026m08');
    assert.ok(row, 'sealed');
    assert.equal(row.row_count, '2');
    assert.equal(row.dropped_at, null, 'within retention');
    const expected = new PartitionSeal();
    for (const r of (await migrate.query('select * from audit.auth_events_y2026m08 order by id')).rows) expected.add(rowDigest(r));
    assert.ok(expected.runningHash.equals(row.running_hash));
  });

  test('a sealed partition past retention is dropped; its seal stays, marked dropped', async () => {
    assert.equal(await exists('audit.auth_events_y2025m01'), false);
    const row = await seal('auth_events_y2025m01');
    assert.equal(row.row_count, '3');
    assert.ok(row.dropped_at);
  });

  test('rows loaded into a sealed partition after it was sealed leave the seal matching', async () => {
    assert.equal(await exists('audit.auth_events_y2025m02'), false, 'dropped at the end of retention');
    assert.ok((await seal('auth_events_y2025m02')).dropped_at);
    assert.ok(!logs.some((l) => l.includes('"partition.seal_mismatch"') && l.includes('auth_events_y2025m02')));
  });

  test('a partition that no longer matches its seal is kept and alerts', async () => {
    assert.ok(await exists('audit.auth_events_y2025m03'));
    assert.equal((await seal('auth_events_y2025m03')).dropped_at, null);
    assert.ok(logs.some((l) => l.includes('"partition.seal_mismatch"') && l.includes('auth_events_y2025m03')));
  });

  test('high-volume audit events go after 400 days; standard ones keep the longer retention', async () => {
    assert.equal(await exists('audit.audit_events_high_volume_y2025m08'), false);
    assert.ok((await seal('audit_events_high_volume_y2025m08')).dropped_at);
    assert.ok(await exists('audit.audit_events_standard_y2025m12'));
    const standard = await seal('audit_events_standard_y2025m12');
    const expected = new PartitionSeal();
    for (const r of (await migrate.query('select row_hash from audit.audit_events_standard_y2025m12 order by id')).rows) expected.add(r.row_hash);
    assert.ok(expected.runningHash.equals(standard.running_hash), 'chained rows contribute their row hash');
  });

  test('an outbox partition goes 14 days after its day, only when every row is settled', async () => {
    const day = (iso: string) => `platform.outbox_d${iso.slice(0, 10).replaceAll('-', '')}`;
    assert.equal(await exists(day(daysAgo(20))), false);
    assert.ok(await exists(day(daysAgo(18))));
    assert.ok(logs.some((l) => l.includes('"outbox.partition_unsettled"')));
  });
});

describe('expiry sweeps', () => {
  test('reset links and sessions 30 days past expiry are removed; newer ones stay', async () => {
    const left = async (table: string, id: string) => Number((await migrate.query(`select count(*) as n from ${table} where id = $1`, [id])).rows[0].n);
    assert.equal(await left('iam.password_resets', ids['oldReset']!), 0);
    assert.equal(await left('iam.password_resets', ids['newReset']!), 1);
    assert.equal(await left('iam.sessions', ids['oldSession']!), 0);
    assert.equal(await left('iam.sessions', ids['newSession']!), 1);
  });

  test('an abandoned OAuth flow is marked expired and its verifier shredded; a settled one goes with the sessions, before the session it held', async () => {
    const flow = async (name: string) => (await migrate.query(
      'select expires_at, expired_at, pkce_verifier_sealed is not null as sealed from connect.oauth_pending_flows where state_hash = $1',
      [Buffer.from(ids[name]!, 'hex')])).rows[0] as { expires_at: string; expired_at: string | null; sealed: boolean } | undefined;
    assert.equal(await flow('settledFlow'), undefined, 'removed, so the old session it held could go too');
    const abandoned = (await flow('abandonedFlow'))!;
    assert.equal(abandoned.expired_at, abandoned.expires_at);
    assert.equal(abandoned.sealed, false);
    const live = (await flow('liveFlow'))!;
    assert.deepEqual([live.expired_at, live.sealed], [null, true]);
  });

  test('an expired view share is closed at its expiry and reported once; a live one stays', async () => {
    const { rows } = await migrate.query('select id, revoked_at, expires_at from workspace.view_shares where id = any($1)', [[ids['expiredShare'], ids['liveShare']]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual(byId[ids['expiredShare']!].revoked_at, byId[ids['expiredShare']!].expires_at);
    assert.equal(byId[ids['liveShare']!].revoked_at, null);
    const events = await migrate.query(`select payload from platform.outbox where organisation_id = $1 and payload->>'event' = 'view_share_expired'`, [org]);
    assert.deepEqual(events.rows.map((r) => r.payload.resource.id), [ids['expiredShare']]);
    assert.deepEqual(events.rows[0].payload.actor, { kind: 'service', service: 'maintenance' });
  });

  test('an expired purpose session is ended as expired and reported; a lapsed live subscription is expired', async () => {
    const purposes = await migrate.query('select id, ended_reason from gov.purpose_sessions where id = any($1) order by id', [[ids['expiredPurpose'], ids['livePurpose']]]);
    assert.deepEqual(Object.fromEntries(purposes.rows.map((r) => [r.id, r.ended_reason])), { [ids['expiredPurpose']!]: 'expired', [ids['livePurpose']!]: null });
    const events = await migrate.query(`select payload from platform.outbox where organisation_id = $1 and payload->>'event' = 'purpose_session_expired'`, [org]);
    assert.deepEqual(events.rows.map((r) => r.payload.resource.id), [ids['expiredPurpose']]);
    const live = await migrate.query('select id, end_reason from clone.live_subscriptions where id = any($1)', [[ids['lapsedLive'], ids['heldLive']]]);
    assert.deepEqual(Object.fromEntries(live.rows.map((r) => [r.id, r.end_reason])), { [ids['lapsedLive']!]: 'expired', [ids['heldLive']!]: null });
  });

  test('a service principal past its expiry is recorded once and reported; a live one is not', async () => {
    const { rows } = await migrate.query('select id, expiry_recorded_at from iam.service_principals where id = any($1)', [[ids['expiredClient'], ids['liveClient']]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.expiry_recorded_at !== null]));
    assert.deepEqual(byId, { [ids['expiredClient']!]: true, [ids['liveClient']!]: false });
    const events = await migrate.query(`select payload from platform.outbox where organisation_id = $1 and payload->>'event' = 'service_principal_expired'`, [org]);
    assert.deepEqual(events.rows.map((r) => r.payload.resource.id), [ids['expiredClient']]);
  });

  test('a pending approval chain past its time expires and is reported; an open one stays pending', async () => {
    const chains = await migrate.query('select id, status from action.approval_chains where id = any($1)', [[ids['expiredChain'], ids['openChain']]]);
    assert.deepEqual(Object.fromEntries(chains.rows.map((r) => [r.id, r.status])), { [ids['expiredChain']!]: 'expired', [ids['openChain']!]: 'pending' });
    const events = await migrate.query(`select payload from platform.outbox where organisation_id = $1 and payload->>'event' = 'approval_expired'`, [org]);
    assert.deepEqual(events.rows.map((r) => r.payload.resource.id), [ids['expiredChain']]);
  });

  test('an expired invitation is closed, so the address can be invited again', async () => {
    const { rows } = await migrate.query('select id, revoked_at, expires_at from iam.invitations order by email');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[ids['expiredInvitation']!].revoked_at, byId[ids['expiredInvitation']!].expires_at);
    assert.equal(byId[ids['openInvitation']!].revoked_at, null);
  });
});
