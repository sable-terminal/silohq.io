// The Silo Agent updating itself through Fleet end to end (spec 10.7, 11.4): the Go binary in
// agent/, built with a Silo release key, asks the cell what to do, checks the release Fleet
// promoted with the key built into it, downloads its binary over its mutual TLS connection,
// and restarts onto it under its launcher. An update that will not start is undone by the
// launcher, which goes back to the binary before and tells the cell why; the cell halts the
// rollout. A release the cell offers that Fleet never signed (a compromised cell) is refused by
// the agent itself. Skipped where no Go toolchain is installed, and on Windows.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { objectKey } from '../../src/infra/objectStorage.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import type { AgentUpdates } from '../../src/services/connect-runtime/agentUpdates.service.ts';
import type { CellFleetAgent } from '../../src/services/fleet-control/cellAgent.service.ts';
import { documentDigest, keyFileSigner, signDocument } from '../../src/services/fleet-control/signing.service.ts';
import { canonicalJson } from '../../src/utils/canonicalJson.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { sha, startReleaseFleet, type ReleaseFleet } from './agentRelease.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';
import { createMemoryStore, type MemoryStore } from './memoryStore.helper.ts';

const run = promisify(execFile);
const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
// What a development build reports itself as (cmd/silo-agent platform()).
const PLATFORM = process.platform === 'linux' && process.arch === 'arm64' ? 'linux_arm64' : 'linux_x86_64';
const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();

let cell: ConnectCell;
let root: Signed;
let dir: string;
let fleet: ReleaseFleet;
let objects: MemoryStore;
let cellAgent: CellFleetAgent;
let updates: AgentUpdates;
let tunnels: AgentTunnels;
let port = 0;
let health = 0;
let agent: { process: ChildProcess; exit: Promise<number | null> } | undefined;
let agentId: string;
let poolId: string;
let stateDir: string;
const logs: string[] = [];

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    server.close(() => resolve(p));
  });
});

async function waitFor<T>(what: string, read: () => Promise<T> | T, check: (value: T) => boolean, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(value)}\n${logs.slice(-20).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const agentRow = async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  'select version, previous_version, updating_to, status from connect.agents where id = $1', [agentId]))).rows[0] as
  { version: string; previous_version: string | null; updating_to: string | null; status: string };
const events = async (name: string) => (await cell.migrate.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by seq`, [cell.org, name]))
  .rows.map((r) => (r as { payload: { detail: Record<string, unknown> } }).payload.detail);
const rollouts = async () => (await cell.migrate.query('select version, status, halt_reason from connect.agent_rollouts order by started_at desc, id desc')).rows as
  { version: string; status: string; halt_reason: string | null }[];
const state = async () => JSON.parse(await readFile(path.join(stateDir, 'bin', 'state.json'), 'utf8')) as
  { current?: { version: string; digest: string }; previous?: { version: string }; failed?: string[] };
const healthOf = (): Promise<{ version?: string }> => new Promise((resolve) => {
  get({ host: '127.0.0.1', port: health, path: '/' }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as { version?: string });
      } catch {
        resolve({});
      }
    });
  }).on('error', () => resolve({}));
});

const build = (output: string, version: string, releaseKey: string): void => {
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-X main.Version=${version} -X main.ReleaseKeys=${releaseKey}`, '-o', output, './cmd/silo-agent'],
    { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });
};

describe('the Silo Agent updates itself through Fleet (spec 10.7, 11.4)', { skip: hasGo ? false : 'no Go toolchain here' }, () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-update-'));
    cell = await createConnectCell();
    root = await cell.signIn('root@acme.example');
    fleet = await startReleaseFleet(cell.h, dir);
    build(path.join(dir, 'silo-agent'), '1.0.0', fleet.releaseKeyForAgent);

    objects = createMemoryStore();
    const ca = await testAgentCa();
    const tls = await testEndpointTls(HOSTNAME);
    await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
    await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
    const storage = { OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' };
    await cell.start(createConnectRuntimeService({
      onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, onAgentUpdates: (u) => { updates = u; },
      agentHeartbeatMs: 200, objects, agentRolloutTickMs: 3_600_000,
    }), 'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
      FLEET_RELEASE_PUBLIC_KEY_FILE: fleet.releasePublicFile, CONNECT_AGENT_FIRST_ORGANISATIONS: cell.org, ...storage,
    });
    await cell.start(createFleetService({ objects, onCellAgent: (a) => { cellAgent = a; } }), 'fleet-control', 'test_app', {
      FLEET_ROLE: 'cell_agent', FLEET_RELEASE_PUBLIC_KEY_FILE: fleet.releasePublicFile, FLEET_AGENT_POLL_MINUTES: '600',
      SERVICE_URL_FLEET_CONTROL: `http://127.0.0.1:${fleet.port}`, ...storage,
    });
    poolId = (await cell.client('gateway').call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;

    health = await freePort();
    stateDir = path.join(dir, 'state');
    const config = path.join(dir, 'agent.json');
    await writeFile(config, JSON.stringify({
      endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir,
      name: 'plant-a', healthListen: `127.0.0.1:${health}`,
    }));
    await chmod(config, 0o600);
    const binary = path.join(dir, 'silo-agent');
    const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    await run(binary, ['enrol', '-config', config, '-token', token]);
    agentId = ((await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select id from connect.agents where pool_id = $1', [poolId]))).rows[0] as { id: string }).id;
    const child = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms', '-update-first', '300ms', '-update-every', '1s'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    agent = { process: child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
    await waitFor('the agent is healthy', () => tunnels?.connected(cell.org, poolId).filter((a) => a.healthy).length ?? 0, (n) => n === 1);
  });

  after(async () => {
    agent?.process.kill('SIGTERM');
    await agent?.exit;
    await fleet?.close();
    await cell?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('it takes the release Fleet promoted: checked, downloaded over the tunnel, restarted onto', async () => {
    const next = path.join(dir, 'build-1.1.0');
    build(next, '1.1.0', fleet.releaseKeyForAgent);
    const bytes = await readFile(next);
    await fleet.release('r110', '1.1.0', { [PLATFORM]: bytes });
    assert.equal(await cellAgent.pull(uuidv7()), 'installed');
    await updates.tick();

    const row = await waitFor('the agent on 1.1.0', agentRow, (r) => r.version === '1.1.0');
    assert.deepEqual([row.previous_version, row.updating_to], ['1.0.0', null]);
    const [updated] = await events('agent_updated');
    assert.deepEqual([updated!['from_version'], updated!['to_version'], updated!['direction']], ['1.0.0', '1.1.0', 'up']);
    const kept = await state();
    assert.deepEqual([kept.current?.version, kept.current?.digest], ['1.1.0', sha(bytes)]);
    const file = await stat(path.join(stateDir, 'bin', 'silo-agent-1.1.0'));
    assert.equal(file.mode & 0o077, 0, 'the binary is the agent user\'s alone');
    assert.equal((await waitFor('the health endpoint', healthOf, (h) => h.version !== undefined)).version, '1.1.0');
    assert.equal(agent!.process.exitCode, null, 'the launcher kept running; the agent restarted under it');
  });

  test('an update that will not start is undone: back to the binary before, the cell told why, the rollout halted', async () => {
    // A binary that exits at once: what a release broken on this host looks like.
    const broken = Buffer.from('#!/bin/sh\nexit 3\n');
    await fleet.release('r120', '1.2.0', { [PLATFORM]: broken });
    assert.equal(await cellAgent.pull(uuidv7()), 'installed');
    await updates.tick();

    const refused = await waitFor('the undone update reported', () => events('agent_update_refused'), (e) => e.length > 0);
    assert.deepEqual([refused[0]!['version'], refused[0]!['outcome'], refused[0]!['reason']], ['1.2.0', 'undone', 'failed_to_start']);
    assert.deepEqual((await rollouts())[0], { version: '1.2.0', status: 'halted', halt_reason: 'refused' });
    const row = await waitFor('the agent back on 1.1.0', agentRow, (r) => r.version === '1.1.0' && r.status === 'healthy' && r.updating_to === null);
    assert.equal(row.version, '1.1.0');
    const kept = await state();
    assert.deepEqual([kept.current?.version, kept.failed], ['1.1.0', ['1.2.0']]);
    assert.equal((await waitFor('the health endpoint', healthOf, (h) => h.version !== undefined)).version, '1.1.0');
  });

  test('a release Fleet never signed, offered by a compromised cell, is refused by the agent itself', async () => {
    // Straight into the cell's table, past every check the cell runs: as a compromised cell would.
    const forger = generateKeyPairSync('ed25519');
    const signer = keyFileSigner(forger.privateKey, 'release', forger.publicKey);
    const bytes = Buffer.from('#!/bin/sh\necho owned\n');
    const manifest = fleet.manifestOf('r-forged', '9.0.0', { [PLATFORM]: bytes });
    const head = { schema: 'silo.channel.v1', channel: 'agent-stable', sequence: 999, releaseId: 'r-forged', manifestDigest: documentDigest(manifest),
      promotedAt: new Date().toISOString(), promotionId: uuidv7() };
    await objects.put('files', objectKey.agentBinary(sha(bytes).slice(7)), bytes, 'application/octet-stream');
    await cell.migrate.query(
      `insert into connect.agent_releases (release_id, version, target, channel, channel_sequence, manifest, manifest_digest, signatures, head, head_signatures, binaries)
       values ('r-forged', '9.0.0', 'commercial', 'agent-stable', 999, $1, $2, $3, $4, $5, $6)`,
      [canonicalJson(manifest), documentDigest(manifest), JSON.stringify([await signDocument(signer, 'release', manifest)]), canonicalJson(head),
        JSON.stringify([await signDocument(signer, 'channel', head)]), JSON.stringify([{ platform: PLATFORM, version: '9.0.0', digest: sha(bytes), bytes: bytes.length }])]);
    await updates.tick();

    const refused = await waitFor('the forged release refused', () => events('agent_update_refused'), (e) => e.some((d) => d['version'] === '9.0.0'));
    const forged = refused.find((d) => d['version'] === '9.0.0')!;
    assert.deepEqual([forged['outcome'], forged['reason']], ['refused', 'signature']);
    assert.equal((await agentRow()).version, '1.1.0');
    await assert.rejects(stat(path.join(stateDir, 'bin', 'silo-agent-9.0.0')), { code: 'ENOENT' }, 'never downloaded');
    assert.deepEqual((await rollouts())[0], { version: '9.0.0', status: 'halted', halt_reason: 'refused' });
  });
});
