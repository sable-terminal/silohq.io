// The Silo Agent end to end (spec 10.2 to 10.4, 14.4): the Go binary in agent/, built here,
// enrols with a token, holds its tunnel, and answers connect-runtime's reads of a customer
// database it alone holds the read-only login for; a source's refusal comes back as its
// SQLSTATE and is classified; a read cannot write; a write runs only on an execution grant
// the cell signed for exactly its statements (spec 10.4), checked by the agent with the key it
// pinned at enrolment, and anything else is refused and audited; a login the cell keeps reaches
// the agent sealed to it for one call, only for a system its host allows, and every use of a
// login, the cell's or the agent's own, is in the unwrap ledger (spec 10.7); revoking the agent
// closes its tunnel and the agent stops. Skipped where no Go toolchain is installed.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { createAgentPool, issueAgentEnrolmentToken, revokeAgent } from '../../src/contracts/connect-registry/agent.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import type { PlanStepInput } from '../../src/contracts/connect/step.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { RowCountMismatch, SourceSqlError, tunnelChannel } from '../../src/services/connect-runtime/agent.service.ts';
import { createGrantSigner, statementsDigest } from '../../src/services/actions/grants.service.ts';
import { createPrivateKey } from 'node:crypto';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { createConnectCell, doc, TEST_GRANT_KEYS, type ConnectCell, type Signed } from './connect.helper.ts';

// The cell runs in this process: a command it serves must not block the event loop.
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
let port = 0;
let tunnels: AgentTunnels;
let binary: string;
let agentProcess: ChildProcess | undefined;
let agentExit: Promise<number | null>;
let customer: pg.Client;
let poolId: string;
let connectionId: string;
let agentId: string;
const customerDb = `agentdb_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
// A private webhook target on the customer's network, under the customer's own CA (spec 20.4).
let hook: HttpsServer | undefined;
let hookPort = 0;
const hooked: { method: string; url: string; body: string; signature: string | undefined }[] = [];
const logs: string[] = [];

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    server.close(() => resolve(p));
  });
});

async function waitFor<T>(read: () => Promise<T> | T, check: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`did not get there: ${JSON.stringify(value)}\n${logs.slice(-10).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sqlManifest = () => doc({
  schemaVersion: '1', identity: { name: 'Orders database', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'placed', type: 'date-time' }],
    source: { kind: 'sql', schema: 'sales', table: 'orders' },
    pushdown: { filters: [{ field: 'id', ops: ['eq', 'gt', 'lte'] }, { field: 'region', ops: ['eq'] }], sort: [{ field: 'id' }] },
  }, {
    name: 'missing', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }], source: { kind: 'sql', schema: 'sales', table: 'nowhere' },
  }],
});

const read = (step: PlanStepInput, from = connectionId) => cell.client('executor').call(readObject, { body: { connectionId: from, reason: 'query', step } }, cell.as(root));

// The same database through a login the cell keeps: its address is the connection's parameters.
const cellLoginManifest = () => doc({
  schemaVersion: '1', identity: { name: 'Orders database', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
  params: [{ name: 'host', label: 'Host' }, { name: 'port', label: 'Port' }, { name: 'database', label: 'Database' }, { name: 'sslmode', label: 'TLS', required: false }],
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }],
    source: { kind: 'sql', schema: 'sales', table: 'orders' }, pushdown: { filters: [{ field: 'id', ops: ['lte'] }], sort: [{ field: 'id' }] },
  }],
});
const unwraps = async (connection: string) => (await cell.migrate.query(
  `select c.field_name, c.custody, u.reason, u.outcome, u.key_version_id is null as no_key
     from iam.credential_unwraps u join connect.connection_credentials c on c.id = u.connection_credential_id
    where c.connection_id = $1 order by u.id`, [connection])).rows as { field_name: string; custody: string; reason: string; outcome: string; no_key: boolean }[];
const agentStatus = async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select status from connect.agents where id = $1', [agentId]))).rows[0]?.status as string | undefined;

describe('the Silo Agent binary, end to end (spec 10)', { skip: hasGo ? false : 'no Go toolchain here' }, () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-bin-'));
    binary = path.join(dir, 'silo-agent');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'webhook.key', '-out', 'webhook.pem', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { cwd: dir, stdio: 'ignore' });
    hook = createHttpsServer({ cert: await readFile(path.join(dir, 'webhook.pem')), key: await readFile(path.join(dir, 'webhook.key')) }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hooked.push({ method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString('utf8'), signature: req.headers['silo-signature'] as string | undefined });
        if (req.url!.startsWith('/status')) { res.setHeader('content-type', 'application/json'); res.end('{"state":"applied"}'); return; }
        res.statusCode = 202;
        res.end('not returned to the cell');
      });
    });
    await new Promise<void>((resolve) => hook!.listen(0, '127.0.0.1', resolve));
    hookPort = (hook.address() as { port: number }).port;
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });

    // The customer's database, and the read-only login they give the agent (spec 10.4).
    const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${customerDb}`);
    await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = 'silo_agent_ro') then create role silo_agent_ro login password 'agent-ro-secret'; end if; end $$`);
    await admin.end();
    customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
    await customer.connect();
    await customer.query(`
      create schema sales;
      create table sales.orders (id integer primary key, region text not null, amount numeric(12,2) not null, placed timestamptz not null);
      insert into sales.orders select g, case when g % 2 = 0 then 'north' else 'south' end, (g * 10.5)::numeric(12,2),
        timestamptz '2026-11-01 09:00:00+00' + g * interval '1 hour' from generate_series(1, 20) g;
      grant usage on schema sales to silo_agent_ro;
      grant select on sales.orders to silo_agent_ro;
      -- The customer lets the agent's login change what Silo's granted writes change; a read still runs read-only.
      grant update on sales.orders to silo_agent_ro;`);

    cell = await createConnectCell();
    root = await cell.signIn('root@acme.example');
    const ca = await testAgentCa();
    const tls = await testEndpointTls(HOSTNAME);
    await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
    await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
    await cell.start(createConnectRuntimeService({
      onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: 200,
    }), 'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem, EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: '100',
    });
    await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
    await cell.start(evaluatorService, 'expression-evaluator', 'test_app');

    const gateway = cell.client('gateway');
    poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
    const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Orders', provider: 'Example', sourceRoute: 'visual' } },
      { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: sqlManifest() } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    let connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: 'Orders', owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId, credentialCustody: 'agent' },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    connectionId = connection.id;
  });

  after(async () => {
    hook?.close();
    agentProcess?.kill('SIGTERM');
    await cell?.close();
    await customer?.end();
    const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${customerDb} with (force)`);
    await admin.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the binary enrols with a token; its key stays on the host, readable by it alone', async () => {
    const health = await freePort();
    const config = path.join(dir, 'agent.json');
    await writeFile(config, JSON.stringify({
      endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
      name: 'plant-a', healthListen: `127.0.0.1:${health}`,
      connections: { [connectionId]: { dsn: `${urlFor(DEFAULT_ADMIN_URL, customerDb).replace(/\/\/[^@]*@/, '//silo_agent_ro:agent-ro-secret@')}?sslmode=disable` } },
      // The systems the cell may send this agent to with a login it keeps (spec 10.7).
      targets: ['127.0.0.1'],
      // The customer's own CA, for a private webhook target (spec 20.4).
      webhookCaFile: path.join(dir, 'webhook.pem'),
    }));
    await chmod(config, 0o644);
    const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    await assert.rejects(run(binary, ['enrol', '-config', config, '-token', token]),
      (error: { stdout?: string }) => String(error.stdout ?? '').includes('chmod 600'), 'a configuration others may read is refused: it holds the login');
    await chmod(config, 0o600);
    try {
      await run(binary, ['enrol', '-config', config, '-token', token]);
    } catch (error) {
      assert.fail(`enrol failed: ${String((error as { stdout?: string }).stdout ?? '')}`);
    }
    assert.equal(((await stat(path.join(dir, 'state', 'agent.key'))).mode & 0o777), 0o600);
    agentId = ((await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select id from connect.agents where pool_id = $1', [poolId]))).rows[0] as { id: string }).id;

    // It renews at once (more than 30 days before expiry), as it would at 20 days, and carries on with the new key.
    agentProcess = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms', '-renew-before', '721h'], { stdio: ['ignore', 'pipe', 'pipe'] });
    agentProcess.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    agentProcess.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    agentExit = new Promise((resolve) => agentProcess!.once('exit', (code) => resolve(code)));
    await waitFor(agentStatus, (s) => s === 'healthy');
    const answer = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${health}/healthz`);
        return { status: res.status, body: await res.json() as { tunnel: string; agentId: string } };
      } catch {
        return { status: 0, body: { tunnel: 'down', agentId: '' } };
      }
    }, (r) => r.status === 200);
    assert.deepEqual(answer.body.tunnel, 'connected');
    assert.equal(answer.body.agentId, agentId);
    await waitFor(() => logs.join(''), (text) => text.includes('agent.certificate_renewed'));
    const renewedEvents = await cell.migrate.query(
      `select 1 from platform.outbox where organisation_id = $1 and payload->>'event' = 'agent_certificate_renewed'`, [cell.org]);
    assert.equal(renewedEvents.rowCount, 1);
    await waitFor(agentStatus, (s) => s === 'healthy');
  });

  test('connect-runtime\'s reads run through the agent against the customer\'s database', async () => {
    const out = await read({ object: 'orders', fields: ['id', 'region', 'amount', 'placed'], filters: [{ field: 'region', op: 'eq', value: 'north' }, { field: 'id', op: 'lte', value: 6 }],
      sort: [{ field: 'id', direction: 'asc' }] });
    assert.deepEqual(out.rows, [
      { id: 2, region: 'north', amount: 21, placed: '2026-11-01T11:00:00.000Z' },
      { id: 4, region: 'north', amount: 42, placed: '2026-11-01T13:00:00.000Z' },
      { id: 6, region: 'north', amount: 63, placed: '2026-11-01T15:00:00.000Z' },
    ]);
    await assert.rejects(read({ object: 'missing' }), { category: 'not_found', code: 'source.not_found' }, 'its SQLSTATE, classified');
    assert.ok(!logs.join('').includes('north'), 'the agent logs no values');
  });

  test('a read cannot write; a write runs only on a grant signed for exactly its statements, once', async () => {
    const channel = tunnelChannel(tunnels);
    const base = { organisationId: cell.org, connectionId, agentPoolId: poolId, dialect: 'postgres', timeoutMs: 5_000, signal: new AbortController().signal };
    await assert.rejects(channel.query({ ...base, maxRows: 10, statement: { text: 'update sales.orders set amount = 0 where id = $1', values: [1] } }),
      (error: unknown) => error instanceof SourceSqlError && error.sqlstate === '25006', 'read_only_sql_transaction');
    const refused = (reason: string) => (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'agent.write_grant_refused' && error.details?.['reason'] === reason;
    const statements = [{ text: 'update sales.orders set amount = $1 where id = $2', values: [99.5, 1], expectRows: 1 }];
    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const grantFor = (signed: typeof statements) => signer.sign({
      organisationId: cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId, object: 'orders', statements: signed.length, payloadSha256: statementsDigest(signed),
    });

    await assert.rejects(channel.transaction!({ ...base, statements }), refused('unsigned'), 'no grant, no write');
    const other = [{ ...statements[0]!, values: [0, 1] }];
    await assert.rejects(channel.transaction!({ ...base, statements: other, grant: grantFor(statements) }), refused('payload'), 'a grant covers what was signed');
    const { rows: [untouched] } = await customer.query('select amount from sales.orders where id = 1');
    assert.equal(untouched.amount, '10.50', 'nothing changed');

    const grant = grantFor(statements);
    assert.deepEqual(await channel.transaction!({ ...base, statements, grant }), { rowCounts: [1] });
    const { rows: [written] } = await customer.query('select amount from sales.orders where id = 1');
    assert.equal(written.amount, '99.50', 'the granted write applied');
    await assert.rejects(channel.transaction!({ ...base, statements, grant }), refused('replayed'), 'a grant runs once');

    // A statement that changes other than it expects rolls the whole write back.
    const plan = [statements[0]!, { text: 'update sales.orders set amount = $1 where id = $2', values: [1, 999], expectRows: 1 }];
    await assert.rejects(channel.transaction!({ ...base, statements: plan, grant: grantFor(plan) }),
      (error: unknown) => error instanceof RowCountMismatch && error.index === 1 && error.rows === 0);
    const refusals = await cell.migrate.query(
      `select payload->'detail'->>'reason' as reason from platform.outbox where organisation_id = $1 and payload->>'event' = 'agent_write_grant_refused' order by created_at`, [cell.org]);
    assert.deepEqual(refusals.rows.map((r) => r.reason), ['unsigned', 'payload', 'replayed'], 'each refusal audited, read first');
  });

  test('an outbound webhook to a private target: posted on a grant over the request, once; its status read with none; a host not allowed, refused (spec 20.4)', async () => {
    const channel = tunnelChannel(tunnels);
    const base = { organisationId: cell.org, connectionId, agentPoolId: poolId, timeoutMs: 10_000, signal: new AbortController().signal };
    const refused = (reason: string) => (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'agent.write_grant_refused' && error.details?.['reason'] === reason;
    const post = { method: 'POST' as const, url: `https://127.0.0.1:${hookPort}/hooks/orders`, headers: { 'content-type': 'application/json', 'silo-signature': 'v1=abc' }, body: '{"mutationId":"m1"}' };
    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const grantFor = (request: typeof post) => signer.sign({
      organisationId: cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId, object: 'webhook', statements: 1, payloadSha256: statementsDigest([request]),
    });
    await assert.rejects(channel.http!({ ...base, statements: [post] }), refused('unsigned'));
    await assert.rejects(channel.http!({ ...base, statements: [{ ...post, body: '{"mutationId":"m2"}' }], grant: grantFor(post) }), refused('payload'));
    assert.equal(hooked.length, 0, 'nothing refused reaches the target');
    const grant = grantFor(post);
    assert.deepEqual(await channel.http!({ ...base, statements: [post], grant }), { status: 202, state: null }, 'the status alone, never the body');
    assert.deepEqual(hooked.at(-1), { method: 'POST', url: '/hooks/orders', body: '{"mutationId":"m1"}', signature: 'v1=abc' });
    await assert.rejects(channel.http!({ ...base, statements: [post], grant }), refused('replayed'), 'a grant runs once');
    assert.deepEqual(await channel.http!({ ...base, statements: [{ method: 'GET', url: `https://127.0.0.1:${hookPort}/status?delivery=d1`, headers: {}, body: '' }] }),
      { status: 200, state: 'applied' });
    await assert.rejects(channel.http!({ ...base, statements: [{ method: 'GET', url: `https://localhost:${hookPort}/status`, headers: {}, body: '' }] }),
      { code: 'agent.target_refused' }, 'the host\'s owner allows 127.0.0.1, not localhost');
  });

  test('a login the cell keeps reaches the agent sealed for one call, only for a system its host allows (spec 10.7)', async () => {
    const gateway = cell.client('gateway');
    const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
    const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Orders', provider: 'Example', sourceRoute: 'visual' } }, keyed());
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: cellLoginManifest() } }, keyed());
    const pgPort = new URL(DEFAULT_ADMIN_URL).port || '5432';
    const connect = async (host: string) => {
      let connection = await gateway.call(createConnection, {
        body: { connectorId: connector.id, name: `Orders at ${host}`, owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId,
          parameters: { host, port: pgPort, database: customerDb, sslmode: 'disable' } },
      }, keyed());
      assert.equal(connection.credentialCustody, 'cell', 'the cell keeps the login by default');
      await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { username: 'silo_agent_ro', password: 'agent-ro-secret' } } }, cell.as(root));
      for (const move of ['probe', 'confirm', 'activate'] as const) {
        if (move === 'confirm') await cell.passConformance(connection.id);
        connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
      }
      return connection.id;
    };
    const cellHeld = await connect('127.0.0.1');
    const out = await read({ object: 'orders', fields: ['id', 'region'], filters: [{ field: 'id', op: 'lte', value: 3 }], sort: [{ field: 'id', direction: 'asc' }] }, cellHeld);
    assert.deepEqual(out.rows, [{ id: 1, region: 'south' }, { id: 2, region: 'north' }, { id: 3, region: 'south' }]);
    const opened = await unwraps(cellHeld);
    assert.deepEqual([...new Set(opened.map((u) => `${u.field_name}:${u.reason}:${u.outcome}`))].sort(), ['password:query:ok', 'username:query:ok'],
      'opened for the call, and recorded');
    assert.ok(!logs.join('').includes('agent-ro-secret'), 'the agent never logs the login');

    // A system the host's owner has not allowed: the agent refuses before it connects.
    const elsewhere = await connect('10.255.255.1');
    await assert.rejects(read({ object: 'orders', fields: ['id'] }, elsewhere), { code: 'agent.login_refused', category: 'forbidden' });
    const targets = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'agent_target_refused' order by created_at`, [cell.org]);
    assert.deepEqual(targets.rows.map((r) => [r.detail.via, r.detail.work]), [['request', 'http.send'], ['login', 'sql.read']],
      'each system the host does not allow, audited: the webhook\'s host above and this login\'s');

    // The agent's own login: nothing opened in the cell, and each use recorded held_by_agent.
    await read({ object: 'orders', fields: ['id'], filters: [{ field: 'id', op: 'lte', value: 1 }] });
    const held = await unwraps(connectionId);
    assert.ok(held.length > 0 && held.every((u) => u.custody === 'agent' && u.outcome === 'held_by_agent' && u.no_key && u.field_name === 'password'));
  });

  test('revoking the agent closes its tunnel, and the agent stops', async () => {
    await cell.client('gateway').call(revokeAgent, { params: { agentId } }, cell.as(root));
    assert.equal(await Promise.race([agentExit, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 15_000))]), 1);
    assert.match(logs.join(''), /agent\.revoked/);
    agentProcess = undefined;
    assert.equal(await agentStatus(), 'revoked');
    await assert.rejects(read({ object: 'orders', fields: ['id'], filters: [{ field: 'id', op: 'eq', value: 1 }] }), { category: 'source_unreachable' });
  });
});
