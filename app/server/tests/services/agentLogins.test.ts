// Logins for connections through the Silo Agent (spec 10.7, 6): cell-held by default, sealed by
// the credential service for one piece of work on one agent and passed by the tunnel; or
// agent-held, the cell holding none and each use recorded held_by_agent. Agents are played over
// mutual TLS by this test with keys of its own, so what reaches an agent can be opened and read.
// The Go agent's side is tests/services/agentBinary.test.ts.

import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAgentPool, issueAgentEnrolmentToken, revokeAgent } from '../../src/contracts/connect-registry/agent.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { AGENT_CREDENTIAL_INFO, sealAgentCredentials } from '../../src/contracts/credential/connectionCredential.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { canonicalJsonBytes } from '../../src/utils/canonicalJson.util.ts';
import { hpkeOpen } from '../../src/utils/hpke.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startFakeAgent, testAgentCa, testAgentKey, testEndpointTls, type FakeAgent, type FakeWork } from './agent.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
const PASSWORD = 'pa"ss\\wörd\n';

let cell: ConnectCell;
let root: Signed;
let dir: string;
let port = 0;
let serverCert = '';
let pool: string;
let otherPool: string;
let cellHeld: string;
let agentHeld: string;
const started: FakeAgent[] = [];

interface Enrolled { agentId: string; cert: string; key: string; sealing?: KeyObject }

async function enrol(poolId: string, name: string, withKey = true): Promise<Enrolled> {
  const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  const key = await testAgentKey();
  const sealing = withKey ? generateKeyPairSync('x25519') : undefined;
  const text = JSON.stringify({
    token, csr: key.csr, name, hostname: `${name}.local`, platform: 'linux_x86_64', version: '1.0.0',
    ...(sealing ? { sealingKey: Buffer.from(sealing.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64') } : {}),
  });
  const res = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/v1/enrol', method: 'POST', servername: HOSTNAME, ca: serverCert, minVersion: 'TLSv1.3',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(text);
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { agentId: res.body['agentId'] as string, cert: res.body['certificate'] as string, key: key.keyPem, ...(sealing ? { sealing: sealing.privateKey } : {}) };
}

const manifest = () => doc({
  schemaVersion: '1', identity: { name: 'Orders database', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
  params: [{ name: 'host', label: 'Host' }, { name: 'database', label: 'Database' }],
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{ name: 'orders', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }], source: { kind: 'sql', schema: 'sales', table: 'orders' } }],
});

const info = (agentId: string, connectionId: string, workId: string): Buffer => Buffer.concat([
  Buffer.from(`${AGENT_CREDENTIAL_INFO}\u0000`), canonicalJsonBytes({ agentId, connectionId, organisationId: cell.org, workId }),
]);
const seal = (connectionId: string, agentId: string, workId = uuidv7()) =>
  cell.client('connect-runtime').call(sealAgentCredentials, { body: { connectionId, reason: 'query', agentId, workId } }, cell.as(root));
const ledger = async (connectionId: string) => (await cell.migrate.query(
  `select c.field_name, c.custody, u.reason, u.outcome, u.calling_service, u.membership_id is not null as by_member
     from iam.credential_unwraps u join connect.connection_credentials c on c.id = u.connection_credential_id
    where c.connection_id = $1 order by u.id`, [connectionId])).rows as
  { field_name: string; custody: string; reason: string; outcome: string; calling_service: string; by_member: boolean }[];

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-logins-'));
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  serverCert = tls.cert;
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  await cell.start(createConnectRuntimeService({ onAgentEndpoint: (p) => { port = p; }, agentHeartbeatMs: 150 }), 'connect-runtime', 'test_app', {
    AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
    AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
  });
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(evaluatorService, 'expression-evaluator', 'test_app');
  const gateway = cell.client('gateway');
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  pool = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
  otherPool = (await gateway.call(createAgentPool, { body: { name: 'Elsewhere', environment: 'production' } }, cell.as(root))).id;
  const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'Orders', provider: 'Example', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest() } }, keyed());
  const connect = async (custody: 'cell' | 'agent', secrets: Record<string, string>) => {
    let connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: `Orders ${custody}`, owningScopeId: cell.scopes['engineering']!, agentPoolId: pool, credentialCustody: custody,
        parameters: { host: 'db.corp.example', database: 'erp' } },
    }, keyed());
    if (Object.keys(secrets).length > 0) await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: secrets } }, cell.as(root));
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    return connection.id;
  };
  cellHeld = await connect('cell', { username: 'reader', password: PASSWORD });
  agentHeld = await connect('agent', {});
});

after(async () => {
  for (const agent of started) agent.close();
  await cell?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('logins through the Silo Agent (spec 10.7)', () => {
  let agent: Enrolled;

  test('a cell-held login is sealed to the agent for one piece of work: only its key opens it, only for that work', async () => {
    agent = await enrol(pool, 'a1');
    const workId = uuidv7();
    const sealed = await seal(cellHeld, agent.agentId, workId);
    assert.equal(sealed.custody, 'cell');
    if (sealed.custody !== 'cell') return;
    const bytes = Buffer.from(sealed.sealed, 'base64');
    assert.ok(!bytes.includes(Buffer.from('reader')) && !bytes.includes(Buffer.from('pa"ss')), 'nothing in clear');
    const opened = JSON.parse(hpkeOpen(agent.sealing!, info(agent.agentId, cellHeld, workId), bytes).toString()) as Record<string, unknown>;
    assert.deepEqual(opened, { expiresAt: sealed.expiresAt, params: { host: 'db.corp.example', database: 'erp' }, username: 'reader', password: PASSWORD });
    assert.ok(Date.parse(sealed.expiresAt) - Date.now() <= 120_000);
    assert.throws(() => hpkeOpen(agent.sealing!, info(agent.agentId, cellHeld, uuidv7()), bytes), 'not for another piece of work');
    assert.throws(() => hpkeOpen(generateKeyPairSync('x25519').privateKey, info(agent.agentId, cellHeld, workId), bytes), 'not with another key');
    const used = await ledger(cellHeld);
    assert.deepEqual(used.map((u) => [u.field_name, u.custody, u.reason, u.outcome, u.calling_service, u.by_member]),
      [['password', 'cell', 'query', 'ok', 'connect-runtime', true], ['username', 'cell', 'query', 'ok', 'connect-runtime', true]]);
  });

  test('refused: an agent of another pool, a revoked agent, an agent with no key to seal to', async () => {
    const stranger = await enrol(otherPool, 'b1');
    await assert.rejects(seal(cellHeld, stranger.agentId), { code: 'credential.agent_not_in_pool' });
    const keyless = await enrol(pool, 'a2', false);
    await assert.rejects(seal(cellHeld, keyless.agentId), { code: 'agent.no_sealing_key' });
    const revoked = await enrol(pool, 'a3');
    await cell.client('gateway').call(revokeAgent, { params: { agentId: revoked.agentId } }, cell.as(root));
    await assert.rejects(seal(cellHeld, revoked.agentId), { code: 'credential.agent_not_in_pool' });
  });

  test('an agent-held login: the cell keeps none, opens nothing, and records each use held_by_agent', async () => {
    await assert.rejects(cell.client('gateway').call(setConnectionSecrets, { params: { connectionId: agentHeld }, body: { values: { password: 'x' } } }, cell.as(root)),
      { code: 'credential.agent_custody' });
    assert.deepEqual(await seal(agentHeld, agent.agentId), { custody: 'agent' });
    assert.deepEqual(await seal(agentHeld, agent.agentId), { custody: 'agent' });
    const used = await ledger(agentHeld);
    assert.deepEqual(used.map((u) => [u.field_name, u.custody, u.outcome]), [['password', 'agent', 'held_by_agent'], ['password', 'agent', 'held_by_agent']]);
  });

  test('the tunnel seals the login for the agent and piece of work it gives the read to', async () => {
    const fake = startFakeAgent({ port, serverCert, servername: HOSTNAME, beatMs: 150, identity: agent, version: '1.0.0', activeCalls: 0 });
    started.push(fake);
    let given: FakeWork | undefined;
    fake.answer = (work) => {
      if (work.kind !== 'sql.read') return undefined;
      given = work;
      return [{ type: 'rows', rows: [{ id: 7 }] }, { type: 'done', rowCount: 1, truncated: false }];
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
    const out = await cell.client('executor').call(readObject, { body: { connectionId: cellHeld, reason: 'query', step: { object: 'orders', fields: ['id'] } } }, cell.as(root));
    assert.deepEqual(out.rows, [{ id: 7 }]);
    const credential = given!.payload['credential'] as { sealed: string; expiresAt: string };
    const opened = JSON.parse(hpkeOpen(agent.sealing!, info(agent.agentId, cellHeld, given!.id), Buffer.from(credential.sealed, 'base64')).toString()) as { password: string };
    assert.equal(opened.password, PASSWORD, 'bound to the work id the agent was given');

    // An agent-held connection's work carries no login.
    await cell.client('executor').call(readObject, { body: { connectionId: agentHeld, reason: 'query', step: { object: 'orders', fields: ['id'] } } }, cell.as(root));
    assert.equal(given!.payload['credential'], undefined);
  });
});
