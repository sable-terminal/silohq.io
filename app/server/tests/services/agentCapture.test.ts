// Change data capture end to end (spec 10.3, 10.4, 18.1, 18.2, 18.7): the Go agent built from
// agent/ reads a customer's Postgres publication with the replication login only it holds.
// The owner confirms the slot with its name shown; an agent of the pool takes the lease and
// makes the slot; committed rows become deltas on bus-live, ordered by their place in the log,
// and are acknowledged only once taken in, so the source lets its log go only then. The agent
// stopping gives up the lease, and the next reader resumes from the acknowledged position
// with nothing lost and nothing published twice. A slot dropped behind Silo's back is lost;
// dropping a capture has the agent drop the slot. An agent without a replication login
// refuses, and the stream says why. With the cell down, the agent reads on into its encrypted
// spool (spec 10.6), waits at the spool's bound rather than drop anything, and sends it all up
// once the cell is back. Skipped where no Go toolchain is installed.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../../src/config/index.config.ts';
import { dropChangeCapture, setChangeCapture } from '../../src/contracts/change-stream/capture.contract.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import { getStreamStatus, type StreamStatusView } from '../../src/contracts/change-stream/stream.contract.ts';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { changeConnectionStatus, createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { connectLiveBus, type LiveBus } from '../../src/infra/bus.infra.ts';
import { registerChangeInterest } from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';
import type { RunningProcess } from '../../src/process.ts';

const run = promisify(execFile);
const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let cell: ConnectCell;
let root: Signed;
let dir: string;
let binary: string;
let config: string;
let port = 0;
let startRuntime: () => Promise<RunningProcess>;
let runtime: RunningProcess;
let agent: { process: ChildProcess; exit: Promise<number | null> } | undefined;
let customer: pg.Client;
let admin: pg.Client;
let bus: LiveBus;
let state: RedisStore;
let poolId: string;
let connectionId: string;
let unloggedId: string;
const received: SourceChange[] = [];
const logs: string[] = [];
const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const customerDb = `capturedb_${suffix}`;
const slotName = `silo_${suffix}`;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    server.close(() => resolve(p));
  });
});

async function waitFor<T>(what: string, read: () => Promise<T> | T, check: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(value)}\n${logs.slice(-12).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const manifest = () => doc({
  schemaVersion: '1', identity: { name: 'Orders database', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'placed', type: 'date-time' }],
    source: { kind: 'sql', schema: 'sales', table: 'orders' },
    pushdown: { filters: [{ field: 'id', ops: ['eq'] }], sort: [{ field: 'id' }] },
  }],
  changeStream: { objects: [{ object: 'orders', sources: [{ kind: 'cdc', method: 'logical_replication' }], ordering: 'source_sequence' }] },
});

const status = (id = connectionId): Promise<StreamStatusView> =>
  cell.client('gateway').call(getStreamStatus, { params: { connectionId: id } }, cell.as(root));
const slotOnSource = async (name = slotName) =>
  (await admin.query('select active, confirmed_flush_lsn::text as flushed from pg_replication_slots where slot_name = $1', [name])).rows[0] as
    { active: boolean; flushed: string } | undefined;
const events = async (event: string) => (await cell.migrate.query(
  `select payload from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [cell.org, event])).rows
  .map((r) => r.payload as { actor: { kind: string; membershipId?: string }; detail: Record<string, unknown> });
const deltas = (entity?: string) => received.filter((d) => d.connectionId === connectionId && (entity === undefined || d.entityRef === entity));
const lsn = (text: string): bigint => {
  const [high, low] = text.split('/');
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
};

/**
 * Drops capture databases' replication slots, then the databases: this run's (mine), or what a
 * killed run left (slots inactive, databases slotless, so never a run going on now). A slot left
 * behind keeps every byte of WAL written after it, so one that will not go fails the run.
 */
async function dropCaptureDatabases(pattern: string, mine: boolean): Promise<void> {
  let left = 0;
  for (const deadline = Date.now() + 15_000; ;) {
    if (mine) await admin.query('select pg_terminate_backend(active_pid) from pg_replication_slots where database like $1 and active_pid is not null', [pattern]);
    // One that turns active between the read and the drop fails the statement: the next round takes it.
    await admin.query('select pg_drop_replication_slot(slot_name) from pg_replication_slots where database like $1 and not active', [pattern]).catch(() => undefined);
    left = Number((await admin.query('select count(*) from pg_replication_slots where database like $1 and (not active or $2)', [pattern, mine])).rows[0].count);
    if (left === 0 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const { rows } = await admin.query(
    'select datname from pg_database d where datname like $1 and not exists (select 1 from pg_replication_slots s where s.database = d.datname)', [pattern]);
  for (const { datname } of rows as { datname: string }[]) await admin.query(`drop database if exists "${datname}" with (force)`);
  if (mine && left !== 0) throw new Error(`${left} replication slots in ${pattern} would not drop: they hold WAL until they do`);
}

function startAgent(): void {
  const child = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  agent = { process: child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

async function stopAgent(): Promise<void> {
  if (agent === undefined) return;
  agent.process.kill('SIGTERM');
  await agent.exit;
  agent = undefined;
}

describe('change data capture through the Silo Agent (spec 10.3, 10.4, 18)', { skip: hasGo ? false : 'no Go toolchain here' }, () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-cdc-'));
    binary = path.join(dir, 'silo-agent');
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });

    // The customer's database: a publication for the captured table, and a read-only replication login (spec 10.4).
    admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
    await admin.connect();
    const { rows: [{ wal_level: level }] } = await admin.query('show wal_level');
    assert.equal(level, 'logical', 'the dev Postgres runs wal_level=logical (docker-compose.yml)');
    await dropCaptureDatabases('capturedb\\_%', false);
    await admin.query(`create database ${customerDb}`);
    await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = 'silo_agent_repl') then
      create role silo_agent_repl login replication password 'agent-repl-secret'; end if; end $$`);
    customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
    await customer.connect();
    await customer.query(`
      create schema sales;
      create table sales.orders (id integer primary key, region text not null, amount numeric(12,2) not null, placed timestamptz not null);
      insert into sales.orders values (1, 'north', 10.50, '2026-11-01 09:00:00+00');
      grant usage on schema sales to silo_agent_repl;
      grant select on sales.orders to silo_agent_repl;
      create publication silo_orders for table sales.orders;`);

    cell = await createConnectCell();
    root = await cell.signIn('root@acme.example');
    const ca = await testAgentCa();
    const tls = await testEndpointTls(HOSTNAME);
    await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
    await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
    const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
    // A service finds those started before it: connect-runtime reports captures to change-stream.
    await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
    // On a port of its own, so the agent finds it again after the test stops and starts it.
    port = await freePort();
    startRuntime = () => cell.start(createConnectRuntimeService({ agentHeartbeatMs: 200, agentCaptureLeaseMs: 3_000, agentCaptureRetryMs: 300 }),
      'connect-runtime', 'test_app', {
        AGENT_ENDPOINT_PORT: String(port), AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
        AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
      });
    runtime = await startRuntime();
    await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
    await cell.start(evaluatorService, 'expression-evaluator', 'test_app');

    const gateway = cell.client('gateway');
    poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
    const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Orders', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest() } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const connect = async (name: string) => {
      let connection = await gateway.call(createConnection, {
        body: { connectorId: connector.id, name, owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId, credentialCustody: 'agent' },
      }, { ...cell.as(root), idempotencyKey: uuidv7() });
      for (const move of ['probe', 'confirm', 'activate'] as const) {
        if (move === 'confirm') await cell.passConformance(connection.id);
        connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
      }
      return connection.id;
    };
    connectionId = await connect('Orders');
    unloggedId = await connect('Orders, no replication login');

    const busConfig = loadConfig({
      SILO_ENV: 'test', SILO_SERVICE: 'change-stream', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
      SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, ...live,
    });
    bus = await connectLiveBus(busConfig.bus, 'test');
    bus.subscribe(sourceChange, 'chg.>', (delta) => {
      if (delta.organisationId === cell.org) received.push(delta);
    });
    await bus.flush();
    state = await connectRedis('state', busConfig.redis);
    await registerChangeInterest(state, CELL_ID, cell.org, connectionId, ['orders']);

    // The agent holds the read login and the replication login; for the second connection, only the read login.
    const login = (user: string, password: string) => `${urlFor(DEFAULT_ADMIN_URL, customerDb).replace(/\/\/[^@]*@/, `//${user}:${password}@`)}?sslmode=disable`;
    config = path.join(dir, 'agent.json');
    await writeFile(config, JSON.stringify({
      endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
      name: 'plant-a', healthListen: `127.0.0.1:${await freePort()}`, spoolMaxMb: 1,
      connections: {
        [connectionId]: { dsn: login('silo_agent_repl', 'agent-repl-secret'), replicationDsn: login('silo_agent_repl', 'agent-repl-secret') },
        [unloggedId]: { dsn: login('silo_agent_repl', 'agent-repl-secret') },
      },
    }));
    await chmod(config, 0o600);
    const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    await run(binary, ['enrol', '-config', config, '-token', token]);
    startAgent();
  });

  after(async () => {
    await stopAgent();
    await bus?.close();
    await state?.close();
    await cell?.close();
    await customer?.end();
    if (admin) {
      try {
        await dropCaptureDatabases(customerDb, true);
      } finally {
        await admin.end();
      }
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the owner confirms the slot by name; an agent of the pool takes the lease and makes it on the customer\'s database', async () => {
    const gateway = cell.client('gateway');
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName: 'Bad-Name', publication: 'silo_orders', confirmed: true } }, cell.as(root)),
      { category: 'validation' }, 'a slot name the source would have to quote is refused');
    const set = await gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName, publication: 'silo_orders', confirmed: true } }, cell.as(root));
    assert.equal(set.capture?.slotName, slotName);
    assert.equal(set.capture?.confirmedBy, root.membershipId);
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName: `${slotName}_2`, publication: 'silo_orders', confirmed: true } }, cell.as(root)),
      { code: 'stream.capture_exists' }, 'one live capture per connection');
    const [created] = await events('cdc_slot_created');
    assert.equal(created?.actor.membershipId, root.membershipId, 'the event names who confirmed the change to their database');
    assert.equal(created?.detail['slot_name'], slotName);

    await waitFor('the slot streams on the source', () => slotOnSource(), (s) => s?.active === true);
    const view = await waitFor('the capture is read and the stream live', () => status(), (v) =>
      v.capture?.reading === true && v.objects[0]?.inUse === 'cdc' && v.objects[0]?.status === 'live');
    assert.equal(view.capture?.status, 'active');
  });

  test('committed rows become deltas in log order, acknowledged once taken in, and the source lets its log go only then', async () => {
    await customer.query(`begin;
      insert into sales.orders values (101, 'south', 99.95, '2026-11-02 10:30:00+00'), (102, 'east', 5.00, '2026-11-02 11:00:00+00');
      commit`);
    await customer.query(`update sales.orders set amount = 120.00 where id = 101`);
    await customer.query(`delete from sales.orders where id = 102`);
    await waitFor('four deltas', () => deltas().length, (n) => n >= 4);
    const [inserted, second, updated, deleted] = deltas();
    assert.deepEqual({ ...inserted, observedAt: undefined, sourceAt: undefined, sourceSeq: undefined }, {
      organisationId: cell.org, connectionId, manifestVersion: '1.0.0', object: 'orders', entityRef: '101', operation: 'insert',
      changed: { id: 101, region: 'south', amount: 99.95, placed: '2026-11-02T10:30:00.000Z' },
      observedAt: undefined, sourceAt: undefined, sourceSeq: undefined, ordering: 'source_sequence', source: 'cdc', markings: [],
    }, 'only declared fields, read as reads read them');
    assert.equal(second?.entityRef, '102');
    assert.equal(updated?.operation, 'update');
    assert.equal(updated?.changed['amount'], 120);
    assert.deepEqual({ op: deleted?.operation, ref: deleted?.entityRef, changed: deleted?.changed }, { op: 'delete', ref: '102', changed: {} });
    const sequences = deltas().map((d) => d.sourceSeq!);
    assert.deepEqual([...sequences].sort(), sequences, 'their places in the log sort as text, in commit order');
    assert.ok(inserted!.sourceAt !== null && Date.parse(inserted!.sourceAt) > Date.now() - 60_000, 'the commit time is the source time');

    const acknowledged = await waitFor('the position acknowledged', () => status(), (v) => v.capture?.acknowledgedPosition !== null);
    const position = acknowledged.capture!.acknowledgedPosition!;
    // The agent reports only acknowledged positions to Postgres (every 10 seconds).
    await waitFor('the source lets its log go up to the acknowledged position', () => slotOnSource(),
      (s) => s !== undefined && lsn(s.flushed) >= lsn(position), 25_000);
    assert.ok(!logs.join('').includes('south'), 'the agent logs no values');
  });

  test('the agent stopping gives up its lease; the next reader resumes from the acknowledged position, losing and repeating nothing', async () => {
    const before = deltas().length;
    await stopAgent();
    await waitFor('the lease given up', () => status(), (v) => v.capture?.reading === false);
    await waitFor('the stream stale without a reader', () => status(), (v) => v.objects[0]?.status === 'stale');
    // change-stream's round notices the lapse and audits it.
    await waitFor('the lapse audited', () => events('stream_stale'), (found) => found.some((e) => e.detail['source'] === 'cdc'));
    await customer.query(`insert into sales.orders values (200, 'west', 1.00, '2026-11-03 08:00:00+00')`);
    startAgent();
    await waitFor('the change made while no agent read', () => deltas('200').length, (n) => n === 1);
    await waitFor('live again', () => status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(deltas().length, before + 1, 'what was acknowledged is not published again');
  });

  test('with the cell down the agent reads on into its sealed spool, waits at the bound, and sends it all up once the cell is back', async () => {
    await waitFor('reading and live', () => status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
    const before = deltas().length;
    await runtime.stop('test');
    await customer.query(`insert into sales.orders values (300, 'spoolregion', 2.00, '2026-11-04 08:00:00+00')`);
    // More than the 1 MB spool holds, in one transaction: the reader waits for room, losing nothing.
    await customer.query(`insert into sales.orders select g, 'bulk-' || repeat('x', 600), 1.00, '2026-11-04 09:00:00+00' from generate_series(1000, 3999) g`);
    await waitFor('the reader waits at the spool\'s bound', () => logs.join(''), (text) => text.includes('agent.cdc_paused'));
    assert.equal((await slotOnSource())?.active, true, 'still holding the slot, with the cell down');
    const queue = path.join(dir, 'state', 'spool', (await cell.migrate.query(
      `select id from connect.cdc_slots where connection_id = $1 and status = 'active'`, [connectionId])).rows[0].id as string);
    const segments = (await readdir(queue)).filter((name) => name.endsWith('.seg'));
    assert.ok(segments.length > 0, 'spooled on the agent\'s host');
    for (const name of segments) {
      assert.ok(!(await readFile(path.join(queue, name))).includes('spoolregion'), 'sealed: no value on disk in clear');
    }

    runtime = await startRuntime();
    await waitFor('everything that happened while the cell was down', () => deltas().length, (n) => n >= before + 3_001, 120_000);
    assert.equal(deltas('300')[0]?.changed['region'], 'spoolregion');
    assert.equal(new Set(deltas().slice(before).map((d) => d.entityRef)).size, 3_001, 'each once');
    await waitFor('live again', () => status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
    assert.equal((await status()).capture?.lastGap, null, 'nothing was lost on the way');
    // What the cell has goes; a position or two with no changes may still wait.
    const spooled = async () => {
      let bytes = 0;
      for (const name of (await readdir(queue)).filter((n) => n.endsWith('.seg'))) bytes += (await readFile(path.join(queue, name))).length;
      return bytes;
    };
    await waitFor('the spool lets go of what the cell has', spooled, (bytes) => bytes < 4 * 1024);
    assert.equal((await events('agent_spool_gap')).length, 0);
  });

  test('a spool damaged on the agent\'s host is a gap record: audited, shown on the stream, and nothing the source holds is lost', async () => {
    await waitFor('reading and live', () => status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
    const slotId = (await status()).capture!.slotId;
    const queue = path.join(dir, 'state', 'spool', slotId);
    await runtime.stop('test');
    await customer.query(`insert into sales.orders select g, 'damaged-' || g, 3.00, '2026-11-05 08:00:00+00' from generate_series(5000, 5099) g`);
    const sealed = async () => (await readdir(queue)).filter((name) => name.endsWith('.seg')).sort();
    await waitFor('spooled', async () => {
      const names = await sealed();
      return names.length === 0 ? 0 : (await readFile(path.join(queue, names.at(-1)!))).length;
    }, (bytes) => bytes > 10 * 1024);
    await stopAgent();
    // Damage the newest sealed record, as a disk fault or tampering would.
    const last = path.join(queue, (await sealed()).at(-1)!);
    const raw = await readFile(last);
    raw[raw.length - 20] = raw[raw.length - 20]! ^ 0xff;
    await writeFile(last, raw);

    const before = deltas().length;
    runtime = await startRuntime();
    startAgent();
    await waitFor('the gap audited', () => events('agent_spool_gap'), (found) => found.some((e) => e.detail['reason'] === 'spool_damaged'));
    const view = await waitFor('the gap shown on the stream', () => status(), (v) => v.capture?.lastGap?.reason === 'spool_damaged');
    assert.equal(view.capture?.lastGap?.changes, null, 'what a damaged record held cannot be counted');
    // The source still holds what the damaged record held: the reader reads it again.
    await waitFor('every row', () => new Set(deltas().slice(before).map((d) => d.entityRef).filter((ref) => Number(ref) >= 5000 && Number(ref) < 5100)).size,
      (n) => n === 100, 60_000);
    await waitFor('live again', () => status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
  });

  test('an agent without the replication login refuses; the stream says why, and another reader is sought', async () => {
    const gateway = cell.client('gateway');
    await gateway.call(setChangeCapture, { params: { connectionId: unloggedId }, body: { slotName: `${slotName}_x`, publication: 'silo_orders', confirmed: true } }, cell.as(root));
    const view = await waitFor('the refusal shown', () => status(unloggedId), (v) =>
      v.objects[0]?.status === 'stale' && (v.objects[0]?.reason ?? '').includes('no replication login'));
    assert.equal(view.capture?.reading, false);
    assert.equal(await slotOnSource(`${slotName}_x`), undefined, 'nothing was made on the source');
  });

  test('a slot dropped behind Silo\'s back is lost; dropping the capture has the agent drop the slot', async () => {
    // Postgres lets a slot go once its reader is gone; the agent retries, so drop it as soon as it is free.
    await waitFor('the slot dropped on the source', async () => {
      await admin.query('select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = $1 and active', [slotName]);
      return admin.query('select pg_drop_replication_slot($1)', [slotName]).then(() => true, () => false);
    }, (dropped) => dropped);
    const lost = await waitFor('the capture lost', () => status(), (v) => v.capture?.status === 'lost');
    assert.equal(lost.objects[0]?.status, 'stale');
    assert.match(lost.objects[0]?.reason ?? '', /lost/);
    assert.equal((await events('cdc_slot_lost'))[0]?.detail['slot_name'], slotName);
    assert.equal(await slotOnSource(), undefined, 'a lost slot is never made again: what it held is gone');

    const gateway = cell.client('gateway');
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName, publication: 'silo_orders', confirmed: true } }, cell.as(root)),
      { code: 'stream.slot_name_in_use' }, 'a name stays taken until its slot is dropped');
    await gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName: `${slotName}_b`, publication: 'silo_orders', confirmed: true } }, cell.as(root));
    await waitFor('the new slot streams', () => slotOnSource(`${slotName}_b`), (s) => s?.active === true);
    const dropping = await gateway.call(dropChangeCapture, { params: { connectionId } }, cell.as(root));
    assert.equal(dropping.capture?.status, 'dropping');
    await waitFor('the agent dropped the slot', () => slotOnSource(`${slotName}_b`), (s) => s === undefined);
    await waitFor('the capture lost earlier is current again', () => status(), (v) => v.capture?.slotName === slotName);
    await gateway.call(dropChangeCapture, { params: { connectionId } }, cell.as(root));
    await waitFor('every capture dropped', () => status(), (v) => v.capture === null);
    const dropped = await events('cdc_slot_dropped');
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((e) => e.actor.membershipId === root.membershipId), 'naming who asked');
  });
});
