// Work for a pool whose agents another connect-runtime replica holds (spec 10.3): two
// replicas of connect-runtime, each holding the tunnels the agents opened to it. Each says
// in the registry (redis-data tun:) where its agents are, how loaded and whether healthy; work
// given at one replica goes to the pool's least-loaded healthy agent wherever its tunnel is,
// relayed to the replica holding it, rows and a source's SQLSTATE intact. An agent the
// registry names but its replica no longer holds, or a replica that cannot be reached, passes
// the work to the next agent, a write only when it never left. An unhealthy agent, or one
// whose tunnel closed, is out of the choice.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { tunnelKeys } from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { SourceSqlError, tunnelChannel } from '../../src/services/connect-runtime/agent.service.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { startFakeAgent, testAgentCa, testAgentKey, testEndpointTls, type FakeAgent, type FakeWork } from './agent.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
const BEAT_MS = 150;
let cell: ConnectCell;
let root: Signed;
let dir: string;
let serverCert = '';
let poolId: string;
let data: RedisStore;
const replicas: Record<'A' | 'B', { endpoint: number; http: number; tunnels?: AgentTunnels }> = { A: { endpoint: 0, http: 0 }, B: { endpoint: 0, http: 0 } };
const started: FakeAgent[] = [];

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

async function waitFor<T>(what: string, read: () => Promise<T> | T, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let value: T | undefined;
    try {
      value = await read();
      if (check(value)) return value;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function enrolPost(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: replicas.A.endpoint, path: '/v1/enrol', method: 'POST', servername: HOSTNAME, ca: serverCert, minVersion: 'TLSv1.3',
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
  const enrolled = await enrolPost({ token, csr: key.csr, name, hostname: `${name}.local`, platform: 'linux_x86_64', version: '1.0.0' });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return { agentId: enrolled.body['agentId'] as string, cert: enrolled.body['certificate'] as string, key: key.keyPem };
}

function startAgent(at: 'A' | 'B', identity: { agentId: string; cert: string; key: string }, activeCalls: number): FakeAgent {
  const agent = startFakeAgent({ port: replicas[at].endpoint, serverCert, servername: HOSTNAME, beatMs: BEAT_MS, identity, version: '1.0.0', activeCalls });
  agent.answer = (work: FakeWork) => {
    if (work.kind === 'ping') return [{ type: 'pong', version: '1.0.0' }];
    if (work.kind === 'sql.transaction') return [{ type: 'done', rowCount: 1, truncated: false, rowCounts: [1] }];
    const text = (work.payload['statement'] as { text: string }).text;
    return text === 'refused' ? [{ type: 'error', category: 'source_refused', sqlstate: '42P01' }]
      : [{ type: 'rows', rows: [{ name: 'pump', held: identity.agentId }] }, { type: 'done', rowCount: 1, truncated: false }];
  };
  started.push(agent);
  return agent;
}

/** Work given at replica B, as connect-runtime's engines give it. */
const ping = async () => {
  const frames = [];
  for await (const frame of replicas.B.tunnels!.dispatch({ organisationId: cell.org, poolId, kind: 'ping', payload: {}, timeoutMs: 3_000 })) frames.push(frame);
  return frames;
};
const base = () => ({ organisationId: cell.org, connectionId: '01a1e000-0000-7000-8000-000000000001', agentPoolId: poolId, dialect: 'postgres', timeoutMs: 3_000,
  signal: new AbortController().signal });

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  dir = await mkdtemp(path.join(tmpdir(), 'silo-relay-'));
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  serverCert = tls.cert;
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  for (const name of ['A', 'B'] as const) {
    const replica = replicas[name];
    replica.http = await freePort();
    await cell.start(createConnectRuntimeService({
      onAgentEndpoint: (p) => { replica.endpoint = p; }, onAgentTunnels: (t) => { replica.tunnels = t; }, agentHeartbeatMs: BEAT_MS,
    }), 'connect-runtime', 'test_app', {
      HTTP_PORT: String(replica.http), AGENT_RELAY_URL: `http://127.0.0.1:${replica.http}`,
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    });
  }
  poolId = (await cell.client('gateway').call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'connect-runtime', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`,
  });
  data = await connectRedis('data', config.redis);
});

after(async () => {
  for (const agent of started) agent.close();
  await data?.close();
  await cell?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('work for agents another replica holds (spec 10.3)', () => {
  let a: FakeAgent;
  let b: FakeAgent;

  test('work given at one replica reaches the pool\'s agent held by another, rows and SQLSTATE intact', async () => {
    a = startAgent('A', await enrolAgent('plant-a'), 0);
    assert.equal(await a.status, 200);
    assert.deepEqual(replicas.B.tunnels!.connected(cell.org, poolId), [], 'replica B holds no tunnel');
    assert.deepEqual(await waitFor('relayed to A', ping, () => true), [{ type: 'pong', version: '1.0.0' }]);
    assert.equal(a.works.filter((w) => w.kind === 'ping').length, 1);

    const channel = tunnelChannel(replicas.B.tunnels!);
    const read = await channel.query({ ...base(), maxRows: 10, statement: { text: 'select', values: [] } });
    assert.deepEqual(read.rows, [{ name: 'pump', held: a.agentId }]);
    await assert.rejects(channel.query({ ...base(), maxRows: 10, statement: { text: 'refused', values: [] } }),
      (error: unknown) => error instanceof SourceSqlError && error.sqlstate === '42P01');
    const tunnel = await data.readHash(tunnelKeys, tunnelKeys.key(cell.org, { agentId: a.agentId }));
    assert.equal(tunnel?.relayUrl, `http://127.0.0.1:${replicas.A.http}`);
    assert.equal(tunnel?.poolId, poolId);
  });

  test('the least-loaded healthy agent of the pool gets the work, wherever its tunnel is', async () => {
    b = startAgent('B', await enrolAgent('plant-b'), 5);
    assert.equal(await b.status, 200);
    await waitFor('b healthy at B', () => replicas.B.tunnels!.connected(cell.org, poolId), (c) => c.some((x) => x.healthy));
    const before = a.works.length;
    await ping();
    assert.equal(a.works.length, before + 1, 'A\'s agent is less loaded, so B relays to it');
    assert.equal(b.works.length, 0);

    a.load.activeCalls = 9;
    await waitFor('B\'s own agent is now the least loaded', async () => {
      await ping();
      return b.works.length;
    }, (n) => n > 0);
  });

  test('an agent its replica no longer holds, or a replica gone, passes the work on; a write only when it never left', async () => {
    // An agent the registry still names: its replica answers that it does not hold it.
    const ghost = await enrolAgent('plant-c');
    await cell.migrate.query(`update connect.agents set tunnel_connected_at = now(), status = 'healthy' where id = $1`, [ghost.agentId]);
    const entry = (relayUrl: string) => ({
      connectRuntimePod: 'elsewhere', tunnelId: 'gone', agentVersion: '1.0.0', connectedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(),
      poolId, relayUrl, healthy: true, activeCalls: 0,
    });
    const key = tunnelKeys.key(cell.org, { agentId: ghost.agentId });
    try {
      await data.putHash(tunnelKeys, key, entry(`http://127.0.0.1:${replicas.A.http}`));
      const before = b.works.length;
      assert.deepEqual(await ping(), [{ type: 'pong', version: '1.0.0' }], 'A says agent.not_here, so the next agent answers');
      assert.equal(b.works.length, before + 1);

      // A replica that cannot be reached: a read passes on, and so does a write that never left.
      await data.putHash(tunnelKeys, key, entry(`http://127.0.0.1:${await freePort()}`));
      const channel = tunnelChannel(replicas.B.tunnels!);
      assert.equal((await channel.query({ ...base(), maxRows: 10, statement: { text: 'select', values: [] } })).rows.length, 1);
      const written = await channel.transaction!({ ...base(), statements: [{ text: 'update', values: [], expectRows: 1 }] });
      assert.deepEqual(written.rowCounts, [1]);
      assert.equal(b.works.filter((w) => w.kind === 'sql.transaction').length, 1, 'the write ran once, on the next agent');
    } finally {
      await data.remove(tunnelKeys, key);
      await cell.migrate.query(`update connect.agents set tunnel_connected_at = null, status = 'offline' where id = $1`, [ghost.agentId]);
    }
  });

  test('an unhealthy agent, or one whose tunnel closed, is out of the choice', async () => {
    a.load.activeCalls = 0;
    a.beating = false;
    await waitFor('A\'s agent unhealthy in the registry', () => data.readHash(tunnelKeys, tunnelKeys.key(cell.org, { agentId: a.agentId })),
      (t) => t?.healthy === false);
    const before = a.works.length;
    await ping();
    assert.equal(a.works.length, before, 'though least loaded, an unhealthy agent gets nothing');

    a.close();
    await waitFor('the closed tunnel leaves the registry', () => data.readHash(tunnelKeys, tunnelKeys.key(cell.org, { agentId: a.agentId })),
      (t) => t === undefined);
    b.close();
    await waitFor('with no agent anywhere, work is refused at once', () => ping().then(() => 'answered', (error: { code?: string }) => error.code), (c) => c === 'agent.unavailable');
  });
});
