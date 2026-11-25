// Silo Agent pools and enrolment (spec 10.2, 10.3, 10.9), through the gateway's services and
// connect-runtime's agent endpoint over TLS 1.3: a pool is created and a single-use token
// issued; an agent enrols with a request for a key it keeps, and gets a 30-day client
// certificate bound to a new agent service principal; a used, wrong or refused token does not
// enrol, and a request the CA refuses does not spend the token; a production pool with fewer
// than two agents says so; revoking an agent revokes its principal.

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAgentPool, issueAgentEnrolmentToken, listAgentPools, revokeAgent } from '../../src/contracts/connect-registry/agent.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { fingerprintOf } from '../../src/services/connect-runtime/agentCa.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx } from '../db/harness.helper.ts';
import { testAgentCa, testAgentKey, testEndpointTls } from './agent.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
let cell: ConnectCell;
let root: Signed;
let dir: string;
let port = 0;
let serverCert = '';
let caPem = '';

/** A call to the agent endpoint as an agent makes it: TLS 1.3 to agent.<cell>, pinning the endpoint's certificate. */
function enrol(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path: '/v1/enrol', method: 'POST', servername: HOSTNAME, ca: serverCert, minVersion: 'TLSv1.3',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const events = async (name: string) => (await cell.migrate.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by seq`, [cell.org, name]))
  .rows.map((r) => r.payload as { detail: Record<string, unknown>; resource: { type: string; id: string } | null });

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-'));
  const ca = await testAgentCa();
  caPem = ca.certificatePem;
  const tls = await testEndpointTls(HOSTNAME);
  serverCert = tls.cert;
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  await cell.start(createConnectRuntimeService({ onAgentEndpoint: (p) => { port = p; } }), 'connect-runtime', 'test_app', {
    AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
    AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
  });
});

after(async () => {
  await cell?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('Silo Agent enrolment (spec 10.2)', () => {
  let poolId: string;
  let agentId: string;

  test('a pool, and a single-use token shown once', async () => {
    const gateway = cell.client('gateway');
    const pool = await gateway.call(createAgentPool, { body: { name: 'Plant network', environment: 'production' } }, cell.as(root));
    poolId = pool.id;
    assert.deepEqual([pool.agents, pool.underProvisioned], [[], true]);
    await assert.rejects(gateway.call(createAgentPool, { body: { name: 'Plant network', environment: 'production' } }, cell.as(root)),
      { code: 'agent.pool_name_taken' });
    const token = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    assert.match(token.token, /^silo_enr_/);
    assert.equal(token.endpoint, HOSTNAME);
    assert.equal(Date.parse(token.expiresAt) - Date.now() > 23.9 * 3_600_000, true);
    const { rows: [stored] } = await cell.migrate.query('select token_hash from connect.agent_enrolment_tokens where id = $1', [token.tokenId]);
    assert.ok(!JSON.stringify(stored).includes(token.token), 'only its hash is kept');
    assert.equal((await events('agent_pool_created')).length, 1);
    assert.equal((await events('agent_enrolment_token_issued')).length, 1);
  });

  test('an agent enrols with a key it keeps; the token is spent; a refused request spends nothing', async () => {
    const gateway = cell.client('gateway');
    const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    const what = { name: 'plant-a', hostname: 'plant-a.local', platform: 'linux_x86_64', version: '1.0.0' };

    const bad = await enrol({ token, csr: `${'x'.repeat(120)}`, ...what });
    assert.deepEqual([bad.status, (bad.body['error'] as { code: string }).code], [400, 'agent.csr_invalid']);

    const key = await testAgentKey();
    const enrolled = await enrol({ token, csr: key.csr, ...what });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
    agentId = enrolled.body['agentId'] as string;
    assert.deepEqual([enrolled.body['organisationId'], enrolled.body['poolId'], enrolled.body['caCertificate']], [cell.org, poolId, caPem]);
    const certificate = new X509Certificate(enrolled.body['certificate'] as string);
    assert.ok(certificate.checkIssued(new X509Certificate(caPem)));
    assert.match(certificate.subject, new RegExp(agentId));

    const again = await enrol({ token, csr: key.csr, ...what });
    assert.deepEqual([again.status, (again.body['error'] as { code: string }).code], [401, 'agent.enrolment_token_invalid'], 'single use');
    const wrong = await enrol({ token: 'silo_inv_' + 'a'.repeat(43), csr: key.csr, ...what });
    assert.equal(wrong.status, 401);

    const { rows: [agent] } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select a.status, a.certificate_fingerprint, a.pool_id, a.platform, a.version, p.kind, p.certificate_fingerprint as principal_fingerprint
         from connect.agents a join iam.service_principals p on p.id = a.service_principal_id where a.id = $1`, [agentId]));
    assert.deepEqual([agent.status, agent.pool_id, agent.platform, agent.version, agent.kind], ['offline', poolId, 'linux_x86_64', '1.0.0', 'agent']);
    assert.deepEqual(agent.certificate_fingerprint, fingerprintOf(certificate.raw));
    assert.deepEqual(agent.principal_fingerprint, agent.certificate_fingerprint);
    const enrolledEvent = (await events('agent_enrolled')).at(-1)!;
    assert.deepEqual([enrolledEvent.resource, enrolledEvent.detail['pool_id']], [{ type: 'agent', id: agentId }, poolId]);
  });

  test('a production pool warns with one agent, not with two; revoking an agent revokes its principal', async () => {
    const gateway = cell.client('gateway');
    assert.equal((await gateway.call(listAgentPools, {}, cell.as(root))).pools[0]!.underProvisioned, true);
    const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    const second = await enrol({ token, csr: (await testAgentKey()).csr, name: 'plant-b', hostname: 'plant-b.local', platform: 'windows_x86_64', version: '1.0.0' });
    assert.equal(second.status, 201);
    const listed = (await gateway.call(listAgentPools, {}, cell.as(root))).pools[0]!;
    assert.deepEqual([listed.agents.length, listed.underProvisioned], [2, false]);

    const revoked = await gateway.call(revokeAgent, { params: { agentId } }, cell.as(root));
    assert.equal(revoked.status, 'revoked');
    assert.equal((await gateway.call(revokeAgent, { params: { agentId } }, cell.as(root))).revokedAt, revoked.revokedAt, 'again changes nothing');
    const { rows: [principal] } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select p.revoked_at from connect.agents a join iam.service_principals p on p.id = a.service_principal_id where a.id = $1', [agentId]));
    assert.ok(principal.revoked_at !== null);
    assert.equal((await events('agent_revoked')).length, 1);
    assert.equal((await gateway.call(listAgentPools, {}, cell.as(root))).pools[0]!.underProvisioned, true, 'one live agent again');
  });
});
