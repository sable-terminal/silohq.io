// Discovery through the Silo Agent end to end (spec 10.5, 19): the Go binary in agent/,
// enrolled with the cell's scan key, runs a scan discovery signed for one approved
// authorisation, as connect-runtime gives it over the tunnel: host configuration, the
// catalogue of a database it holds credentials for, and a port scan, each held to the
// authorisation's targets. Everything it does comes back probe by probe; what it found is
// structure, never a row. A scan not signed by the cell, or signed once and sent again, is
// refused by the agent itself; revoking the authorisation stops a scan in flight. Skipped
// where no Go toolchain is installed.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { startDiscoveryScan } from '../../src/contracts/connect-runtime/discoveryScan.contract.ts';
import {
  getScanRun, listFindings, requestScanAuthorisation, revokeScanAuthorisation, setDiscoveryEnabled, startScan, type RunView,
} from '../../src/contracts/discovery/discovery.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createDiscoveryService } from '../../src/routes/discovery/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { createScanSigner } from '../../src/services/discovery/scans.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { createConnectCell, TEST_SCAN_KEYS, type ConnectCell, type Signed } from './connect.helper.ts';

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
let admin: Signed;
let approver: Signed;
let dir: string;
let port = 0;
let tunnels: AgentTunnels;
let agent: { process: ChildProcess; exit: Promise<number | null> } | undefined;
let agentId: string;
let poolId: string;
let ssh: Server;
let sshPort = 0;
let closedPort = 0;
const pgPort = Number(new URL(DEFAULT_ADMIN_URL).port || 5432);
const customerDb = `discodb_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const logs: string[] = [];

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
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(value)}\n${logs.slice(-15).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const runOf = (runId: string) => cell.client('gateway').call(getScanRun, { params: { runId } }, cell.as(admin));
const probes = async (runId: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  'select host, port, method, outcome from connect.discovery_probes where run_id = $1 order by method, port', [runId]))).rows as
  { host: string; port: number | null; method: string; outcome: string }[];

async function authorised(body: { ranges: string[]; methods: string[]; maxHosts: number }): Promise<string> {
  const gateway = cell.client('gateway');
  const a = await gateway.call(requestScanAuthorisation, {
    body: { agentId, ...body, methods: body.methods as never, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  }, keyed(admin));
  await gateway.call(decideApproval, { params: { chainId: a.approvalChainId }, body: { decision: 'approved', diffHash: a.documentHash } }, cell.as(approver));
  return a.id;
}

describe('discovery through the Silo Agent binary (spec 10.5, 19)', { skip: hasGo ? false : 'no Go toolchain here' }, () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-disco-'));
    const binary = path.join(dir, 'silo-agent');
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });

    // The customer's database, a value in it that must never leave, and the agent's read-only login.
    const pgAdmin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
    await pgAdmin.connect();
    await pgAdmin.query(`create database ${customerDb}`);
    await pgAdmin.query(`do $$ begin if not exists (select from pg_roles where rolname = 'silo_agent_ro') then create role silo_agent_ro login password 'agent-ro-secret'; end if; end $$`);
    await pgAdmin.end();
    const customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
    await customer.connect();
    await customer.query(`
      create schema sales;
      create table sales.customers (id integer primary key, email text not null unique, name text);
      create table sales.orders (id bigint primary key, customer_id integer not null references sales.customers (id), total numeric(12,2));
      insert into sales.customers values (1, 'private-person@example.com', 'Private Person');
      insert into sales.orders values (10, 1, 99.50);
      analyze;
      grant usage on schema sales to silo_agent_ro;
      grant select on all tables in schema sales to silo_agent_ro;`);
    await customer.end();

    // On the agent's host: an SSH server that greets, and a port nothing listens on.
    ssh = createServer((socket) => { socket.end('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3\r\n'); });
    await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
    sshPort = (ssh.address() as { port: number }).port;
    closedPort = await freePort();

    cell = await createConnectCell();
    root = await cell.signIn('root@acme.example');
    admin = await cell.member('adm@acme.example', 'Admin', 'engineering');
    approver = await cell.member('appr@acme.example', 'Admin', 'engineering');
    const ca = await testAgentCa();
    const tls = await testEndpointTls(HOSTNAME);
    await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
    await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
    await cell.start(approvalsService, 'approvals', 'test_app');
    await cell.start(ontologyService, 'ontology', 'test_app');
    // connect-runtime and discovery call each other: discovery's address is fixed first.
    const discoveryPort = await freePort();
    await cell.start(createConnectRuntimeService({
      onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: 200, agentScanReportMs: 200,
    }), 'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem, SERVICE_URL_DISCOVERY: `http://127.0.0.1:${discoveryPort}`,
    });
    await cell.start(createDiscoveryService({ sweep: false }), 'discovery', 'test_app', { HTTP_PORT: String(discoveryPort) });
    poolId = (await cell.client('gateway').call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
    await cell.client('gateway').call(setDiscoveryEnabled, { body: { enabled: true } }, cell.as(root));

    // The agent: a connection it holds a login for, the host's ODBC data sources, the ports to try.
    const odbc = path.join(dir, 'odbc.ini');
    await writeFile(odbc, `[Warehouse]\nDriver=PostgreSQL Unicode\nServername=127.0.0.1\nPort=${pgPort}\nUID=report\nPWD=odbc-secret\n\n`
      + '[Elsewhere]\nDriver=PostgreSQL Unicode\nServername=203.0.113.50\nPort=5432\n', { mode: 0o600 });
    const health = await freePort();
    const config = path.join(dir, 'agent.json');
    await writeFile(config, JSON.stringify({
      endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
      name: 'plant-a', healthListen: `127.0.0.1:${health}`,
      connections: { [uuidv7()]: { dsn: `${urlFor(DEFAULT_ADMIN_URL, customerDb).replace(/\/\/[^@]*@/, '//silo_agent_ro:agent-ro-secret@')}?sslmode=disable` } },
      discoveryPorts: [sshPort, closedPort, pgPort], discoveryConfigPaths: [odbc],
    }));
    await chmod(config, 0o600);
    const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    await run(binary, ['enrol', '-config', config, '-token', token]);
    agentId = ((await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select id from connect.agents where pool_id = $1', [poolId]))).rows[0] as { id: string }).id;
    const child = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    agent = { process: child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
    await waitFor('the agent is healthy', () => tunnels?.connected(cell.org, poolId).filter((a) => a.healthy).length ?? 0, (n) => n === 1);
  });

  after(async () => {
    agent?.process.kill('SIGTERM');
    await agent?.exit;
    await cell?.close();
    ssh?.close();
    const pgAdmin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
    await pgAdmin.connect();
    await pgAdmin.query(`drop database if exists ${customerDb} with (force)`);
    await pgAdmin.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('a signed scan runs on the agent: every probe reported, structure found, nothing outside the targets', async () => {
    const authorisationId = await authorised({
      ranges: ['127.0.0.1'], methods: ['host_config', 'catalogue_introspection', 'port_scan', 'opcua_browse'], maxHosts: 5,
    });
    const started = await cell.client('gateway').call(startScan, { params: { authorisationId } }, keyed(admin));
    const done = await waitFor('the scan ends', () => runOf(started.id), (r: RunView) => r.status !== 'running');
    assert.equal(done.status, 'completed', JSON.stringify(done.reasons));
    // OPC UA browse is carried out: this organisation has no industrial endpoint in the targets, so nothing is browsed.
    assert.deepEqual(done.reasons, []);
    assert.equal(done.hostsContacted, 1);

    const seen = await probes(started.id);
    const outcome = (method: string, p: number) => seen.find((x) => x.method === method && x.port === p)?.outcome;
    assert.ok(seen.every((p) => p.host === '127.0.0.1'), 'the ODBC source at 203.0.113.50 is outside the targets: never reported');
    assert.equal(outcome('host_config', pgPort), 'identified');
    assert.equal(outcome('catalogue_introspection', pgPort), 'identified');
    assert.equal(outcome('port_scan', sshPort), 'identified');
    assert.equal(outcome('port_scan', pgPort), 'identified');
    assert.equal(outcome('port_scan', closedPort), 'closed');
    const probed = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select count(*)::int as n from platform.outbox where payload->>'event' = 'host_probed' and payload->'resource'->>'id' = $1`, [started.id]));
    assert.equal(probed.rows[0].n, seen.length, 'one host_probed event per probe');

    const findings = (await cell.client('gateway').call(listFindings, { query: { runId: started.id } }, cell.as(admin))).findings;
    const catalogue = findings.find((f) => f.found.schemas.length > 0)!;
    assert.equal(catalogue.proposedConnectorType, 'sql:postgres');
    const tables = catalogue.found.schemas.find((s) => s.name === 'sales')!.tables;
    assert.deepEqual(tables.map((t) => t.name).sort(), ['customers', 'orders']);
    assert.deepEqual(tables.find((t) => t.name === 'orders')!.foreignKeys.map((k) => [k.columns.join(), k.targetTable]), [['customer_id', 'customers']]);
    assert.deepEqual(catalogue.proposedLinks.map((l) => [l.from, l.to, l.origin]), [['sales.orders', 'sales.customers', 'declared']]);
    assert.ok(findings.some((f) => f.found.product === 'OpenSSH' && f.found.port === sshPort));
    const everything = JSON.stringify(findings);
    for (const never of ['private-person', 'Private Person', 'agent-ro-secret', 'odbc-secret', '99.5']) assert.ok(!everything.includes(never), `${never} left the database`);
    assert.ok(logs.join('').includes('agent.discovery_started'));
  });

  test('the agent refuses a scan the cell did not sign, and a signed one sent twice', async () => {
    const authorisationId = await authorised({ ranges: ['127.0.0.1'], methods: ['port_scan'], maxHosts: 1 });
    const a = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select c.policy_snapshot->'document' as document from connect.discovery_authorisations a join action.approval_chains c on c.id = a.approval_chain_id where a.id = $1`,
      [authorisationId]));
    const { canonicalJson } = await import('../../src/utils/canonicalJson.util.ts');
    const text = canonicalJson(a.rows[0].document);
    const scanFor = (signer: ReturnType<typeof createScanSigner>, runId: string) =>
      signer.sign({ scanId: runId, organisationId: cell.org, agentId, authorisationId, authorisation: text });
    const forger = createScanSigner(generateKeyPairSync('ed25519').privateKey);
    const runtime = cell.client('discovery');
    const as = { request: { organisationId: cell.org }, correlationId: uuidv7() };

    // connect-runtime checks the signature before anything reaches the agent.
    await assert.rejects(runtime.call(startDiscoveryScan, {
      params: { agentId }, body: { runId: uuidv7(), scan: scanFor(forger, uuidv7()), deadline: new Date(Date.now() + 60_000).toISOString(), relayed: false },
    }, as), { code: 'discovery.scan_refused' });

    // Past it, the agent checks for itself: given straight down its tunnel, a forged scan is refused.
    const give = async (scan: unknown) => {
      const frames = [];
      for await (const frame of tunnels.dispatch({ organisationId: cell.org, poolId, agentId, kind: 'discovery.scan', payload: { scan }, timeoutMs: 10_000 })) frames.push(frame);
      return frames;
    };
    const forgedRun = uuidv7();
    assert.deepEqual(await give(scanFor(forger, forgedRun)), [{ type: 'end', status: 'failed', reason: 'refused:key_unknown' }]);
    // The cell's own signature, but sent a second time: refused as replayed, nothing probed.
    const genuine = scanFor(createScanSigner(createPrivateKey(TEST_SCAN_KEYS.privateKey)), uuidv7());
    const first = await give(genuine);
    assert.equal(first.at(-1)!.type, 'end');
    assert.deepEqual(await give(genuine), [{ type: 'end', status: 'failed', reason: 'refused:replayed' }]);
    assert.ok(logs.join('').includes('agent.discovery_refused'));
  });

  test('revoking the authorisation stops a scan in flight on the agent', async () => {
    // TEST-NET-1: nothing answers, so the scan is slow and still going when it is revoked.
    const authorisationId = await authorised({ ranges: ['192.0.2.0/24'], methods: ['port_scan'], maxHosts: 300 });
    const started = await cell.client('gateway').call(startScan, { params: { authorisationId } }, keyed(admin));
    await waitFor('the scan is under way', async () => (await probes(started.id)).length, (n) => n > 0);
    await cell.client('gateway').call(revokeScanAuthorisation, { params: { authorisationId } }, cell.as(admin));
    const ended = await waitFor('the run is revoked', () => runOf(started.id), (r: RunView) => r.status !== 'running');
    assert.equal(ended.status, 'revoked');
    assert.deepEqual(ended.reasons, ['authorisation_revoked']);
    await waitFor('the agent stops', () => logs.join(''), (text) => text.includes('agent.discovery_stopped'));
    const after = (await probes(started.id)).length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal((await probes(started.id)).length, after, 'nothing more is probed or recorded');
    assert.ok(after < 300, `${after} of the range probed before the stop`);
  });
});
