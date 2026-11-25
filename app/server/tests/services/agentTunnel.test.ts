// The agent tunnel (spec 10.2, 10.3, 10.7), through connect-runtime's agent endpoint, with
// agents played by this test over HTTP/2 and mutual TLS, speaking the frames the Go agent
// speaks: a tunnel needs the agent's own certificate; heartbeats keep an agent healthy, three
// missed mark it unhealthy and the next marks it recovered; work goes to the least-loaded
// healthy agent of the pool and is answered only by that agent; a revoked agent's tunnel
// closes; with no agent connected, work is refused at once; the SQL engine's channel reads
// rows through the tunnel and keeps a source's SQLSTATE.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAgentPool, issueAgentEnrolmentToken, revokeAgent } from '../../src/contracts/connect-registry/agent.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { SourceSqlError, tunnelChannel } from '../../src/services/connect-runtime/agent.service.ts';
import { fingerprintOf } from '../../src/services/connect-runtime/agentCa.service.ts';
import { X509Certificate } from 'node:crypto';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx } from '../db/harness.helper.ts';
import { startFakeAgent, testAgentCa, testAgentKey, testEndpointTls, type FakeAgent, type FakeWork } from './agent.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
const BEAT_MS = 150;
let cell: ConnectCell;
let root: Signed;
let dir: string;
let port = 0;
let serverCert = '';
let tunnels: AgentTunnels;
let poolId: string;

function post(body: unknown, pathname = '/v1/enrol', tls: { cert?: string; key?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path: pathname, method: 'POST', servername: HOSTNAME, ca: serverCert, minVersion: 'TLSv1.3', ...tls,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function enrolAgent(name: string): Promise<{ agentId: string; cert: string; key: string }> {
  const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  const key = await testAgentKey();
  const enrolled = await post({ token, csr: key.csr, name, hostname: `${name}.local`, platform: 'linux_x86_64', version: '1.0.0' });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return { agentId: enrolled.body['agentId'] as string, cert: enrolled.body['certificate'] as string, key: key.keyPem };
}

const started: FakeAgent[] = [];

function startAgent(identity: { agentId: string; cert: string; key: string }, version: string, activeCalls: number): FakeAgent {
  const agent = startFakeAgent({ port, serverCert, servername: HOSTNAME, beatMs: BEAT_MS, identity, version, activeCalls });
  started.push(agent);
  return agent;
}

async function waitFor<T>(read: () => Promise<T> | T, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`did not get there: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const statusOf = async (agentId: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  'select status, tunnel_connected_at, last_heartbeat_at, active_calls from connect.agents where id = $1', [agentId]))).rows[0] as
  { status: string; tunnel_connected_at: string | null; last_heartbeat_at: string | null; active_calls: number };
const events = async (name: string) => (await cell.migrate.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by seq`, [cell.org, name])).rows;
const ping = async () => {
  const frames = [];
  for await (const frame of tunnels.dispatch({ organisationId: cell.org, poolId, kind: 'ping', payload: {}, timeoutMs: 3_000 })) frames.push(frame);
  return frames;
};

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  dir = await mkdtemp(path.join(tmpdir(), 'silo-tunnel-'));
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  serverCert = tls.cert;
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  await cell.start(createConnectRuntimeService({
    onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: BEAT_MS,
  }), 'connect-runtime', 'test_app', {
    AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
    AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
  });
  poolId = (await cell.client('gateway').call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
});

after(async () => {
  for (const agent of started) agent.close();
  await cell?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the agent tunnel (spec 10.2, 10.3)', () => {
  let a: FakeAgent;
  let b: FakeAgent;
  let bIdentity: { agentId: string; cert: string; key: string };
  let aIdentity: { agentId: string; cert: string; key: string };

  test('a tunnel needs the agent\'s own certificate; with none connected, work is refused at once', async () => {
    const refused = await post({}, '/v1/tunnel');
    assert.deepEqual([refused.status, (refused.body['error'] as { code: string }).code], [401, 'agent.certificate_required']);
    await assert.rejects(ping(), { category: 'source_unreachable', code: 'agent.unavailable' }, 'never queued (spec 10.6)');
  });

  test('a connected agent is healthy and answers its work', async () => {
    aIdentity = await enrolAgent('plant-a');
    a = startAgent(aIdentity, '1.0.0', 5);
    assert.equal(await a.status, 200);
    const healthy = await waitFor(() => statusOf(a.agentId), (s) => s.status === 'healthy' && s.tunnel_connected_at !== null && s.last_heartbeat_at !== null);
    assert.equal(healthy.active_calls, 5, 'the first heartbeat is written at once, with its load');
    assert.deepEqual(await ping(), [{ type: 'pong', version: '1.0.0' }]);
  });

  test('work goes to the least-loaded healthy agent, and only that agent may answer it', async () => {
    bIdentity = await enrolAgent('plant-b');
    b = startAgent(bIdentity, '1.0.1', 1);
    await waitFor(() => tunnels.connected(cell.org, poolId), (c) => c.length === 2 && c.every((x) => x.healthy));
    await waitFor(() => statusOf(b.agentId), (s) => s.status === 'healthy');
    // Let both report their load before giving work.
    await new Promise((resolve) => setTimeout(resolve, BEAT_MS * 2));
    assert.deepEqual(await ping(), [{ type: 'pong', version: '1.0.1' }], 'b reports fewer calls');

    b.answer = () => undefined;
    const answer = ping();
    const given = await waitFor(() => b.works.filter((w) => w.kind === 'ping'), (w) => w.length === 2);
    assert.equal(await a.respond(given[1]!.id, [{ type: 'pong', version: '9.9.9' }]), 403, 'a may not answer b\'s work');
    assert.equal(await b.respond(given[1]!.id, [{ type: 'pong', version: '1.0.1' }]), 200);
    assert.deepEqual(await answer, [{ type: 'pong', version: '1.0.1' }]);
    b.answer = (work) => (work.kind === 'ping' ? [{ type: 'pong', version: '1.0.1' }] : undefined);
  });

  test('three missed heartbeats mark an agent unhealthy and it gets no work; the next marks it recovered', async () => {
    b.beating = false;
    await waitFor(() => statusOf(b.agentId), (s) => s.status === 'unhealthy');
    assert.equal((await events('agent_unhealthy')).length, 1);
    assert.deepEqual(await ping(), [{ type: 'pong', version: '1.0.0' }], 'only a, though b reports fewer calls');
    b.beating = true;
    await waitFor(() => statusOf(b.agentId), (s) => s.status === 'healthy');
    assert.equal((await events('agent_recovered')).length, 1);
  });

  test('the SQL engine reads rows through the tunnel, and keeps a refusal\'s SQLSTATE', async () => {
    const answers: Record<string, unknown[]> = {
      ok: [{ type: 'rows', rows: [{ id: 1, name: 'pump' }] }, { type: 'rows', rows: [{ id: 2, name: 'valve' }] }, { type: 'done', rowCount: 2 }],
      refused: [{ type: 'error', category: 'source_refused', sqlstate: '42P01' }],
    };
    const answering = (work: FakeWork) => (work.kind === 'sql.read' ? answers[(work.payload['statement'] as { text: string }).text] : work.kind === 'ping' ? [{ type: 'pong', version: '1' }] : undefined);
    a.answer = answering;
    b.answer = answering;
    const channel = tunnelChannel(tunnels);
    const base = { organisationId: cell.org, connectionId: '00000000-0000-7000-8000-000000000001', agentPoolId: poolId, dialect: 'postgres', maxRows: 100,
      timeoutMs: 3_000, signal: new AbortController().signal };
    const read = await channel.query({ ...base, statement: { text: 'ok', values: [] } });
    assert.deepEqual(read.rows.map((r) => r['name']), ['pump', 'valve']);
    await assert.rejects(channel.query({ ...base, statement: { text: 'refused', values: [] } }),
      (error: unknown) => error instanceof SourceSqlError && error.sqlstate === '42P01');
    const given = [...a.works, ...b.works].find((w) => w.kind === 'sql.read')!;
    assert.deepEqual(Object.keys(given.payload).sort(), ['connectionId', 'dialect', 'maxRows', 'statement'], 'the statement and its bounds, nothing more');
  });

  test('an agent renews its certificate with a new key over its tunnel\'s mutual TLS; the old one then opens nothing', async () => {
    const renewal = await testAgentKey();
    const renewed = await post({ csr: renewal.csr }, '/v1/renew', { cert: aIdentity.cert, key: aIdentity.key });
    assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
    assert.equal(renewed.body['agentId'], a.agentId);
    const { rows: [row] } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select a.certificate_fingerprint, p.certificate_fingerprint as principal from connect.agents a
         join iam.service_principals p on p.id = a.service_principal_id where a.id = $1`, [a.agentId]));
    assert.deepEqual(row.certificate_fingerprint, fingerprintOf(new X509Certificate(renewed.body['certificate'] as string).raw));
    assert.deepEqual(row.principal, row.certificate_fingerprint);
    assert.equal((await events('agent_certificate_renewed')).length, 1);
    await new Promise((resolve) => setTimeout(resolve, BEAT_MS * 3));
    assert.equal((await statusOf(a.agentId)).status, 'healthy', 'the live tunnel follows the new fingerprint');
    const again = await post({ csr: (await testAgentKey()).csr }, '/v1/renew', { cert: aIdentity.cert, key: aIdentity.key });
    assert.equal(again.status, 401, 'the old certificate is no longer anyone\'s');
    a.close();
    a = startAgent({ agentId: a.agentId, cert: renewed.body['certificate'] as string, key: renewal.keyPem }, '1.0.0', 5);
    assert.equal(await a.status, 200, 'the new certificate opens the tunnel');
    await waitFor(() => tunnels.connected(cell.org, poolId), (c) => c.some((x) => x.agentId === a.agentId && x.healthy));
  });

  test('a revoked agent\'s tunnel closes at its next heartbeat; a closed tunnel leaves the agent offline', async () => {
    await cell.client('gateway').call(revokeAgent, { params: { agentId: b.agentId } }, cell.as(root));
    await waitFor(() => b.closes, (c) => c.includes('revoked'));
    await waitFor(() => tunnels.connected(cell.org, poolId), (c) => c.length === 1);
    assert.equal((await statusOf(b.agentId)).status, 'revoked', 'still revoked once its tunnel is gone');
    const again = startAgent(bIdentity, '1.0.1', 0);
    assert.equal(await again.status, 403, 'a revoked agent cannot open a tunnel');
    again.close();

    a.close();
    await waitFor(() => statusOf(a.agentId), (s) => s.status === 'offline' && s.tunnel_connected_at === null);
    await assert.rejects(ping(), { category: 'source_unreachable' });
  });
});
