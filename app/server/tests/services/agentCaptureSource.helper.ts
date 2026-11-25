// A customer database captured through the built Silo Agent, for each capture method's
// end-to-end test: a connect cell with change-stream and connect-runtime (on a port of its own,
// so the agent finds it again after a restart), one pool, a connector per manifest given and an
// agent-held connection of each, bus-live subscribed for the deltas, and the agent enrolled with
// the replication logins given, started and stopped by the test.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/index.config.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import { getStreamStatus, type StreamStatusView } from '../../src/contracts/change-stream/stream.contract.ts';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { changeConnectionStatus, createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
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
import { run } from './agentSource.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    server.close(() => resolve(p));
  });
});

export interface CaptureSource {
  cell: ConnectCell;
  root: Signed;
  /** The connections, in the order of the manifests given. */
  connections: string[];
  logs: string[];
  received: SourceChange[];
  waitFor<T>(what: string, read: () => Promise<T> | T, check: (value: T) => boolean, ms?: number): Promise<T>;
  status(connectionId?: string): Promise<StreamStatusView>;
  events(event: string): Promise<{ actor: { kind: string; membershipId?: string }; detail: Record<string, unknown> }[]>;
  deltas(entity?: string): SourceChange[];
  startAgent(): void;
  stopAgent(): Promise<void>;
  close(): Promise<void>;
}

/** An orders manifest of the dialect streaming orders by the capture method. */
export const capturedOrdersManifest = (dialect: string, method: 'binlog' | 'change_tracking', schema: string | undefined,
  fields: { name: string; type: string }[]) => doc({
  schemaVersion: '1', identity: { name: `Orders (${dialect})`, provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect },
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'], fields,
    source: { kind: 'sql', ...(schema === undefined ? {} : { schema }), table: 'orders' },
    pushdown: { filters: [{ field: 'id', ops: ['eq'] }], sort: [{ field: 'id' }] },
  }],
  changeStream: { objects: [{ object: 'orders', sources: [{ kind: 'cdc', method }], ordering: 'source_sequence' }] },
});

export async function startCaptureSource(input: {
  name: string;
  manifests: ReturnType<typeof doc>[];
  /** The agent's logins for the connections: index i is the i-th connection's; absent, none. */
  logins: ({ dsn: string; replicationDsn: string } | undefined)[];
}): Promise<CaptureSource> {
  const dir = await mkdtemp(path.join(tmpdir(), `silo-agent-${input.name}-`));
  const binary = path.join(dir, 'silo-agent');
  execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });
  const logs: string[] = [];
  const received: SourceChange[] = [];

  const cell = await createConnectCell();
  const root = await cell.signIn('root@acme.example');
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  // A service finds those started before it: connect-runtime reports captures to change-stream.
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
  const port = await freePort();
  await cell.start(createConnectRuntimeService({ agentHeartbeatMs: 200, agentCaptureLeaseMs: 3_000, agentCaptureRetryMs: 300 }),
    'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: String(port), AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    });
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(evaluatorService, 'expression-evaluator', 'test_app');

  const gateway = cell.client('gateway');
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
  const connections: string[] = [];
  for (const document of input.manifests) {
    const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Orders', provider: 'Example', sourceRoute: 'visual' } }, keyed());
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed());
    let connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: 'Orders', owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId, credentialCustody: 'agent' },
    }, keyed());
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    connections.push(connection.id);
  }

  const busConfig = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'change-stream', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, ...live,
  });
  const bus: LiveBus = await connectLiveBus(busConfig.bus, 'test');
  bus.subscribe(sourceChange, 'chg.>', (delta) => {
    if (delta.organisationId === cell.org) received.push(delta);
  });
  await bus.flush();
  const state: RedisStore = await connectRedis('state', busConfig.redis);
  for (const connectionId of connections) await registerChangeInterest(state, CELL_ID, cell.org, connectionId, ['orders']);

  const config = path.join(dir, 'agent.json');
  const logins: Record<string, { dsn: string; replicationDsn: string }> = {};
  input.logins.forEach((login, i) => {
    if (login !== undefined) logins[connections[i]!] = login;
  });
  await writeFile(config, JSON.stringify({
    endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
    name: 'plant-a', healthListen: `127.0.0.1:${await freePort()}`, connections: logins,
  }));
  await chmod(config, 0o600);
  const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  await run(binary, ['enrol', '-config', config, '-token', token]);

  let agent: { process: ChildProcess; exit: Promise<number | null> } | undefined;
  const source: CaptureSource = {
    cell, root, connections, logs, received,
    async waitFor(what, read, check, ms = 30_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await read();
        if (check(value)) return value;
        if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(value)}\n${logs.slice(-12).join('')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    status: (connectionId = connections[0]!) => gateway.call(getStreamStatus, { params: { connectionId } }, cell.as(root)),
    events: async (event) => (await cell.migrate.query(
      `select payload from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [cell.org, event])).rows
      .map((r) => r.payload as { actor: { kind: string; membershipId?: string }; detail: Record<string, unknown> }),
    deltas: (entity) => received.filter((d) => d.connectionId === connections[0] && (entity === undefined || d.entityRef === entity)),
    startAgent() {
      const child = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
      child.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
      agent = { process: child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
    },
    async stopAgent() {
      if (agent === undefined) return;
      agent.process.kill('SIGTERM');
      await agent.exit;
      agent = undefined;
    },
    async close() {
      await source.stopAgent();
      await bus.close();
      await state.close();
      await cell.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return source;
}
