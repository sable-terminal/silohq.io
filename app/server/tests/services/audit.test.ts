// The audit path end to end on a fresh cell database: auth, policy, the outbox relay and
// the audit service as real processes, with JetStream as bus-durable. Auth events and
// product events go through the outbox to the ledger; the chain verifies, survives
// redelivery, closes a daily head and exposes tampering; reads follow the reader's grant.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { listAuditEvents, listAuthEvents, listChainHeads, readAuditChain } from '../../src/contracts/audit/read.contract.ts';
import { acceptInvitation, createInvitation } from '../../src/contracts/auth/invitation.contract.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { inTransaction, openDatabases, withTransaction, type Databases } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuditService } from '../../src/routes/audit/index.route.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { createOutboxRelayService } from '../../src/routes/outbox-relay/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { closeChainHeads, utcDate } from '../../src/services/audit/chain.service.ts';
import { createAuditWriter, type AuditWriter } from '../../src/services/audit/writer.service.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';
const ADMIN_URL = process.env['TEST_PG_ADMIN_URL'] ?? DEFAULT_ADMIN_URL;
const AUDIT_LOGIN = 'test_audit_svc';
const consumer = `audit-t${randomBytes(4).toString('hex')}`;
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
const processes: RunningProcess[] = [];
let gateway: ServiceClient;
let auditDatabases: Databases;
let writer: AuditWriter;
let org: string;
let rootMembership: string;
const scopes: Record<string, string> = {};
const roles: Record<string, string> = {};
const invitations: { email: string; token: string }[] = [];

const env = (service: string, url: string, extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: url,
  REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl, ...extra,
});

async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const count = async (sql: string, params: unknown[]): Promise<number> => Number((await migrate.query(sql, params)).rows[0].n);

async function enqueueAuditEvent(payload: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await inTx(app, { orgId: org }, () => app.query(
    `insert into platform.outbox (id, organisation_id, topic, ordering_key, event, schema_version, payload, correlation_id)
     values ($1, $2, 'audit.events', $3, 'audit_event', 1, $4, $5)`, [id, org, org, JSON.stringify(payload), uuidv7()]));
  return id;
}

const productEvent = (overrides: Record<string, unknown> = {}) => ({
  event: 'org_export_requested', actor: { kind: 'membership', membershipId: rootMembership }, subjectMembershipId: null, scopeId: null,
  resource: null, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: { item_count: 3 }, ...overrides,
});

interface Signed { membershipId: string; sessionId: string }
const as = (who: Signed) => ({ request: { organisationId: org, membershipId: who.membershipId, sessionId: who.sessionId } });
let root: Signed;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);

  // The audit service's login: the ledger writer, and silo_app to read scopes and grants.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [AUDIT_LOGIN]);
    if (!rowCount) await admin.query(`create role ${AUDIT_LOGIN} login password 'test'`).catch(() => undefined);
    await admin.query(`grant silo_audit_writer, silo_app to ${AUDIT_LOGIN}`);
  } finally {
    await admin.end();
  }
  const auditUrl = urlFor(ADMIN_URL, h.cell, AUDIT_LOGIN, 'test');

  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  org = created.organisationId;
  rootMembership = created.membershipId;
  const { rows } = await inTx(app, { orgId: org }, () => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;
  const type = uuidv7();
  await inTx(app, { orgId: org }, async () => {
    await app.query('insert into iam.scope_types (id, organisation_id, name) values ($1, $2, $3)', [type, org, 'Department']);
    for (const [name, parent] of [['engineering', null], ['platform', 'engineering'], ['sales', null]] as const) {
      scopes[name] = uuidv7();
      await app.query(
        'insert into iam.scopes (id, organisation_id, scope_type_id, name, parent_scope_id, path, depth, created_by) values ($1, $2, $3, $4, $5, $6, 1, $7)',
        [scopes[name], org, type, name, parent ? scopes[parent] : null, 'x', rootMembership]);
    }
  });

  const policy = await runProcess([policyService], env('policy', h.url('test_app')), { logger: quiet });
  const authConfig = env('auth', h.url('test_auth'), {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024',
    ARGON2_PASSES: '1', SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
  })], authConfig, { logger: quiet });
  const relay = await runProcess([createOutboxRelayService({ idleMs: 50 })], env('outbox-relay', h.url('test_relay')), { logger: quiet });
  const audit = await runProcess([createAuditService({ consumer })], env('audit', auditUrl, {
    SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  }), { logger: quiet });
  processes.push(audit, relay, auth, policy);
  gateway = createServiceClient({
    caller: 'gateway',
    http: { ...authConfig.http, serviceUrls: { auth: `http://127.0.0.1:${auth.port}`, audit: `http://127.0.0.1:${audit.port}` } },
  });
  auditDatabases = openDatabases(env('audit', auditUrl).postgres, 'audit', ['control']);
  writer = createAuditWriter({ databases: auditDatabases, logger: quiet });
  root = await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD } });
});

after(async () => {
  gateway?.close();
  for (const p of processes) await p.stop('test');
  await auditDatabases?.close(1000);
  await h?.close();
  // The test's durable consumer, so runs do not accumulate them.
  const nc = await connect({ servers: LOCAL.natsUrl });
  await (await jetstreamManager(nc)).consumers.delete('SILO_DURABLE', `${consumer}-audit-events`).catch(() => undefined);
  await nc.drain();
});

describe('auth events reach audit.auth_events through the outbox', () => {
  test('a login is recorded once, with the outbox event id', async () => {
    const recorded = await until('the login event', async () => {
      const { rows } = await migrate.query(
        `select source_event_id, detail, occurred_at from audit.auth_events where organisation_id = $1 and event = 'login'`, [org]);
      return rows.length > 0 ? rows : undefined;
    });
    assert.equal(recorded.length, 1);
    const source = recorded[0].source_event_id as string;
    const outbox = await migrate.query('select created_at, published_at from platform.outbox where id = $1', [source]);
    assert.ok(outbox.rows[0].published_at, 'the relay marked it published');
    assert.equal(recorded[0].occurred_at, outbox.rows[0].created_at, 'occurred_at is the change\'s commit time');

    const page = await gateway.call(listAuthEvents, { query: { event: 'login' } }, as(root));
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.sourceEventId, source);
    assert.equal('source_event_id' in (page.events[0]!.detail as object), false);
  });
});

describe('product events are chained per organisation', () => {
  const ids: string[] = [];

  test('each event is appended in order and the chain verifies', async () => {
    for (let i = 0; i < 5; i++) ids.push(await enqueueAuditEvent(productEvent({ detail: { item_count: i } })));
    await until('five chained events', async () =>
      (await count('select count(*) as n from audit.audit_events where organisation_id = $1', [org])) === 5 ? true : undefined);
    const { rows } = await migrate.query(
      'select source_event_id, chain_seq from audit.audit_events where organisation_id = $1 order by chain_seq', [org]);
    assert.deepEqual(rows.map((r) => r.source_event_id), ids, 'chain order is the outbox order of the organisation');
    assert.deepEqual(rows.map((r) => r.chain_seq), ['1', '2', '3', '4', '5']);

    const chain = await gateway.call(readAuditChain, { query: {} }, as(root));
    assert.deepEqual(chain.verification, { ok: true, count: 5, lastHash: chain.events[4]!.rowHash });
    const tail = await gateway.call(readAuditChain, { query: { afterChainSeq: '3' } }, as(root));
    assert.equal(tail.anchor.rowHash, chain.events[2]!.rowHash);
    assert.equal(tail.verification.ok, true);
  });

  test('the audit view lists newest first and pages', async () => {
    const first = await gateway.call(listAuditEvents, { query: { limit: 2 } }, as(root));
    assert.equal(first.events.length, 2);
    assert.equal(first.events[0]!.chainSeq, '5');
    assert.ok(first.nextCursor);
    const rest = await gateway.call(listAuditEvents, { query: { limit: 10, cursor: first.nextCursor! } }, as(root));
    assert.deepEqual(rest.events.map((e) => e.chainSeq), ['3', '2', '1']);
    assert.equal(rest.nextCursor, null);
  });

  test('a redelivered event is stored once; a message this cell cannot hold is acknowledged, not retried', async () => {
    const { rows } = await migrate.query('select id, created_at, correlation_id, payload from platform.outbox where id = $1', [ids[0]]);
    const row = rows[0];
    const data = Buffer.from(JSON.stringify({ organisationId: org, occurredAt: row.created_at, correlationId: row.correlation_id, payload: row.payload }));
    assert.equal(await writer.handle({ eventId: row.id, name: 'audit_event', version: 1, data }), 'duplicate');
    assert.equal(await count('select count(*) as n from audit.audit_events where organisation_id = $1', [org]), 5);

    const foreign = Buffer.from(JSON.stringify({ organisationId: uuidv7(), occurredAt: row.created_at, correlationId: row.correlation_id, payload: row.payload }));
    assert.equal(await writer.handle({ eventId: uuidv7(), name: 'audit_event', version: 1, data: foreign }), 'rejected');
    assert.equal(await writer.handle({ eventId: uuidv7(), name: 'no_such_message', version: 1, data }), 'rejected');
    assert.equal(await writer.handle({ eventId: uuidv7(), name: 'audit_event', version: 1, data: Buffer.from('{}') }), 'rejected');
  });

  test('the daily head is closed, published and anchored in the chain', async () => {
    const tomorrow = utcDate(Date.now() + 86_400_000);
    const closed = await inTransaction(auditDatabases.pool('control'), { organisationId: org }, (db) => closeChainHeads(db, org, tomorrow));
    assert.equal(closed, 1);
    const { heads } = await gateway.call(listChainHeads, { query: {} }, as(root));
    assert.equal(heads.length, 1);
    const chain = await gateway.call(readAuditChain, { query: {} }, as(root));
    assert.equal(heads[0]!.headDate, utcDate(Date.now()));
    assert.equal(heads[0]!.lastChainSeq, '5');
    assert.equal(heads[0]!.eventCount, '5');
    assert.equal(heads[0]!.headHash, chain.events[4]!.rowHash);
    assert.ok(heads[0]!.publishedAt);
    const published = chain.events[5]!;
    assert.equal(published.event, 'audit_chain_head_published');
    assert.equal(published.systemService, 'audit');
    assert.equal((published.detail as Record<string, unknown>)['head_hash'], heads[0]!.headHash);
    assert.equal(chain.verification.ok, true);
    // Closing again closes nothing.
    assert.equal(await inTransaction(auditDatabases.pool('control'), { organisationId: org }, (db) => closeChainHeads(db, org, tomorrow)), 0);
  });
});

describe('reads follow the reader\'s grant (spec 63.5)', () => {
  let scoped: Signed;

  before(async () => {
    const email = 'eng.admin@acme.example';
    await gateway.call(createInvitation, { body: { email, roleId: roles['Admin']!, scopeId: scopes['engineering']! } },
      { ...as(root), idempotencyKey: uuidv7() });
    scoped = await gateway.call(acceptInvitation, {
      body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: 'Eng', lastName: 'Admin' },
    });
    await enqueueAuditEvent(productEvent({ event: 'tenant_placed', scopeId: scopes['platform'] }));
    await enqueueAuditEvent(productEvent({ event: 'tenant_placed', scopeId: scopes['engineering'] }));
    await enqueueAuditEvent(productEvent({ event: 'tenant_placed', scopeId: scopes['sales'] }));
    await until('the scoped events', async () =>
      (await count(`select count(*) as n from audit.audit_events where organisation_id = $1 and event = 'tenant_placed'`, [org])) === 3 ? true : undefined);
  });

  test('a scope admin names the scope and reads its subtree only', async () => {
    const page = await gateway.call(listAuditEvents, { query: { scopeId: scopes['engineering']!, event: 'tenant_placed' } }, as(scoped));
    assert.deepEqual(page.events.map((e) => e.scopeId).sort(), [scopes['engineering'], scopes['platform']].sort());
  });

  test('without a scope, or outside it, the reader is refused', async () => {
    await assert.rejects(gateway.call(listAuditEvents, { query: {} }, as(scoped)), (e: { code?: string }) => e.code === 'audit.scope_required');
    await assert.rejects(gateway.call(listAuthEvents, { query: {} }, as(scoped)), (e: { code?: string }) => e.code === 'audit.scope_required');
    await assert.rejects(gateway.call(listAuditEvents, { query: { scopeId: scopes['sales']! } }, as(scoped)),
      (e: { code?: string }) => e.code === 'audit.not_permitted');
    await assert.rejects(gateway.call(readAuditChain, { query: {} }, as(scoped)), (e: { code?: string }) => e.code === 'audit.not_permitted',
      'export is not an Admin permission');
  });

  test('the invitation and the join reached the auth ledger', async () => {
    await until('member_joined', async () =>
      (await count(`select count(*) as n from audit.auth_events where organisation_id = $1 and event in ('member_invited', 'member_joined')`, [org])) === 2
        ? true : undefined);
  });
});

describe('tampering is detected (spec 63.1)', () => {
  test('a changed row breaks verification at that row', async () => {
    const admin = new pg.Client({ connectionString: urlFor(ADMIN_URL, h.cell) });
    await admin.connect();
    try {
      // Only a superuser that disables the triggers can do this; the chain still notices.
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(`update audit.audit_events set detail = '{"item_count": 99}' where organisation_id = $1 and chain_seq = 3`, [org]);
      await admin.query('commit');
    } finally {
      await admin.end();
    }
    const chain = await gateway.call(readAuditChain, { query: {} }, as(root));
    assert.deepEqual(chain.verification, { ok: false, chainSeq: '3', reason: 'row_hash' });
  });
});
