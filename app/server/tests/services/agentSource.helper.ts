// A customer database reached through the built Silo Agent, for each dialect's end-to-end test:
// a connect cell with connect-runtime terminating agent tunnels, one pool, a connector of the
// dialect's manifest, an agent-held connection (its login in the agent's configuration) and a
// cell-held one (its login sealed in the cell, its address the connection's parameters), and
// the agent enrolled and running with 127.0.0.1 as its allowed target.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection as tcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import type { PlanStepInput } from '../../src/contracts/connect/step.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

export const run = promisify(execFile);
const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
export const SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;

export const reachable = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = tcp({ host: '127.0.0.1', port }, () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
});

export const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    server.close(() => resolve(p));
  });
});

/** The orders table every dialect's test makes, as a manifest of the dialect reads it. */
export const ordersManifest = (dialect: string, schema: string) => doc({
  schemaVersion: '1', identity: { name: `Orders (${dialect})`, provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect },
  params: [{ name: 'host', label: 'Host', required: false }, { name: 'port', label: 'Port', required: false },
    { name: 'database', label: 'Database', required: false }, { name: 'sslmode', label: 'TLS', required: false }],
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'placed', type: 'date-time' },
      { name: 'shipped', type: 'date' }, { name: 'active', type: 'boolean' }, { name: 'code', type: 'string' }],
    source: { kind: 'sql', schema, table: 'orders' },
    pushdown: { filters: [{ field: 'id', ops: ['eq', 'lte'] }, { field: 'region', ops: ['eq'] }], sort: [{ field: 'id' }] },
  }, { name: 'missing', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }], source: { kind: 'sql', schema, table: 'nowhere' } }],
});

/** The rows the orders table holds for ids 1 to 3, as the cell reads them whatever the dialect. */
export const ORDERS = [
  { id: 1, region: 'south', amount: 10.5, placed: '2026-11-01T10:00:00.250Z', shipped: '2026-11-03', active: true, code: '\\xcafe' },
  { id: 2, region: 'north', amount: 21, placed: '2026-11-01T11:00:00.000Z', shipped: null, active: false, code: null },
  { id: 3, region: 'south', amount: 31.5, placed: '2026-11-01T12:00:00.000Z', shipped: '2026-11-04', active: true, code: null },
];
export const ORDERS_STEP: PlanStepInput = { object: 'orders', fields: ['id', 'region', 'amount', 'placed', 'shipped', 'active', 'code'],
  filters: [{ field: 'id', op: 'lte', value: 3 }], sort: [{ field: 'id', direction: 'asc' }] };

export interface AgentSource {
  cell: ConnectCell;
  root: Signed;
  tunnels: AgentTunnels;
  poolId: string;
  agentHeld: string;
  cellHeld: string;
  logs: string[];
  read(connectionId: string, step: PlanStepInput): ReturnType<ReturnType<ConnectCell['client']>['call']>;
  setPassword(connectionId: string, password: string): Promise<void>;
  close(): Promise<void>;
}

export async function startAgentSource(input: {
  dialect: string;
  manifest: ReturnType<typeof doc>;
  /** The cell-held connection's parameters: its address. */
  cellParameters?: Record<string, string>;
  /** A source with a login: the cell-held connection's; absent for one without (a file share). */
  login?: { username: string; password: string };
  /** The agent-held connection's DSN, in the agent's configuration. */
  agentDsn?: string;
  /** Which connections to make: both by default. */
  custodies?: ('agent' | 'cell')[];
  /** More of the agent's configuration (a file share's fileRoots). */
  agentConfig?: Record<string, unknown>;
}): Promise<AgentSource> {
  const dir = await mkdtemp(path.join(tmpdir(), `silo-agent-${input.dialect}-`));
  const binary = path.join(dir, 'silo-agent');
  execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });
  const cell = await createConnectCell();
  const root = await cell.signIn('root@acme.example');
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  let port = 0;
  let tunnels: AgentTunnels | undefined;
  await cell.start(createConnectRuntimeService({ onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: 200 }),
    'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    });
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(evaluatorService, 'expression-evaluator', 'test_app');

  const gateway = cell.client('gateway');
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
  const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Orders', provider: 'Example', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: input.manifest } }, keyed());
  const setPassword = async (connectionId: string, password: string) => {
    await gateway.call(setConnectionSecrets, { params: { connectionId }, body: { values: { username: input.login!.username, password } } }, cell.as(root));
  };
  const connect = async (custody: 'cell' | 'agent') => {
    let connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: `Orders ${custody}`, owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId, credentialCustody: custody,
        ...(custody === 'cell' && input.cellParameters !== undefined ? { parameters: input.cellParameters } : {}) },
    }, keyed());
    if (custody === 'cell' && input.login !== undefined) await setPassword(connection.id, input.login.password);
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    return connection.id;
  };
  const custodies = input.custodies ?? ['agent', 'cell'];
  const agentHeld = custodies.includes('agent') ? await connect('agent') : '';
  const cellHeld = custodies.includes('cell') ? await connect('cell') : '';

  const config = path.join(dir, 'agent.json');
  await writeFile(config, JSON.stringify({
    endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
    name: 'plant-a', healthListen: `127.0.0.1:${await freePort()}`, targets: ['127.0.0.1'],
    ...(agentHeld !== '' && input.agentDsn !== undefined ? { connections: { [agentHeld]: { dsn: input.agentDsn } } } : {}),
    ...input.agentConfig,
  }));
  await chmod(config, 0o600);
  const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  await run(binary, ['enrol', '-config', config, '-token', token]);
  const logs: string[] = [];
  const agent: ChildProcess = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  agent.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const deadline = Date.now() + 30_000;
  while ((tunnels?.connected(cell.org, poolId).filter((a) => a.healthy).length ?? 0) !== 1) {
    if (Date.now() > deadline) assert.fail(`the agent did not connect\n${logs.slice(-10).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    cell, root, tunnels: tunnels!, poolId, agentHeld, cellHeld, logs, setPassword,
    read: (connectionId, step) => cell.client('executor').call(readObject, { body: { connectionId, reason: 'query', step } }, cell.as(root)),
    async close() {
      agent.kill('SIGTERM');
      await cell.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
