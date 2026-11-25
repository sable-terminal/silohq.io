// One front door on 443 (docs/siloOperations.doc.md section 10): Silo behind a customer's own
// ingress, which routes by the TLS server name. The agent's hostname is passed through untouched,
// so the agent's mutual TLS ends at the cell's agent endpoint; the web hostname is decrypted there
// and re-encrypted to the gateway, which takes the client's address from X-Forwarded-For with one
// trusted hop. Proved with the Go agent binary (it enrols and holds its tunnel through the
// passthrough, and refuses an ingress that decrypts its traffic, naming who re-signed it), with requests from two client addresses (IPv4 and IPv6 loopback) counted apart by
// the gateway's per-address limit while a client's own X-Forwarded-For is ignored, and with the
// live WebSocket upgraded through it. Skipped where no Go toolchain is installed.

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect as tlsConnect, createServer as createTlsServer } from 'node:tls';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { createConnectCell, PASSWORD, type ConnectCell, type Signed } from './connect.helper.ts';

const run = promisify(execFile);
const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
const AGENT_HOST = `agent.${CELL_ID}.silohq.io`;
const WEB_HOST = `silo.${CELL_ID}.silohq.io`;
const ORIGIN = `https://${WEB_HOST}`;
const LIVE_PATH = '/api/v1/live';
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
let agentEndpointPort = 0;
let gatewayPort = 0;
let front: NetServer;
let frontPort = 0;
let terminator: HttpsServer;
let terminatorPort = 0;
/** The client behind each connection the front door opened to the terminator, by its local port: one device, so it knows. */
const clientOf = new Map<number, string>();
let webTls: { cert: string; key: string };
let agentProcess: ChildProcess | undefined;
const routed: string[] = [];
/** When set, the front door decrypts the agent's hostname too, re-signed by its own authority: a TLS-inspecting ingress. */
let inspectAgent = false;
let inspector: NetServer | undefined;
let inspectorPort = 0;

/** The server name of a TLS ClientHello, or undefined while it has not all arrived (or has none). */
function serverNameOf(hello: Buffer): string | null | undefined {
  if (hello.length < 5) return undefined;
  if (hello[0] !== 0x16) return null;
  const recordEnd = 5 + hello.readUInt16BE(3);
  if (hello.length < recordEnd) return undefined;
  let at = 5;
  if (hello[at] !== 0x01) return null;
  at += 4 + 2 + 32;
  at += 1 + hello[at]!;
  at += 2 + hello.readUInt16BE(at);
  at += 1 + hello[at]!;
  const extensionsEnd = at + 2 + hello.readUInt16BE(at);
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(at);
    const length = hello.readUInt16BE(at + 2);
    if (type === 0x0000) {
      // server_name: a list; its first entry, of type host_name.
      const nameLength = hello.readUInt16BE(at + 7);
      return hello.subarray(at + 9, at + 9 + nameLength).toString('ascii');
    }
    at += 4 + length;
  }
  return null;
}

/**
 * The customer's ingress, as its configuration would read: one port; the agent's hostname passed
 * through as bytes (TCP, by server name); the web hostname's TLS ended here, as the same device
 * would, and each request sent on re-encrypted with the client's address appended.
 */
function startFrontDoor(): Promise<void> {
  front = createNetServer((client: Socket) => {
    let seen = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      const name = serverNameOf(seen);
      if (name === undefined) return;
      client.off('data', onData);
      client.pause();
      routed.push(name ?? 'none');
      if (name === AGENT_HOST) {
        const upstream = netConnect(inspectAgent ? inspectorPort : agentEndpointPort, '127.0.0.1', () => {
          upstream.write(seen);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      } else if (name === WEB_HOST) {
        const upstream = netConnect(terminatorPort, '127.0.0.1', () => {
          clientOf.set(upstream.localPort!, (client.remoteAddress ?? '').replace(/^::ffff:/, ''));
          upstream.write(seen);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      } else {
        client.destroy();
      }
    };
    client.on('data', onData);
  });
  return new Promise((resolve) => front.listen(0, '::', () => {
    frontPort = (front.address() as { port: number }).port;
    resolve();
  }));
}

/** The client's address as the ingress saw it, appended to what came before (never replacing it). */
const forwardedFor = (req: IncomingMessage) => {
  const peer = clientOf.get(req.socket.remotePort ?? 0) ?? (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const prior = req.headers['x-forwarded-for'];
  return prior === undefined ? peer : `${Array.isArray(prior) ? prior.join(', ') : prior}, ${peer}`;
};

function startTerminator(): Promise<void> {
  terminator = createHttpsServer({ cert: webTls.cert, key: webTls.key }, (req, res) => {
    const upstream = httpsRequest({
      host: '127.0.0.1', port: gatewayPort, servername: WEB_HOST, ca: webTls.cert, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': forwardedFor(req) },
    }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
  });
  // A WebSocket upgrade, sent on as it came, with the address appended; then bytes both ways.
  terminator.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const upstream = tlsConnect({ host: '127.0.0.1', port: gatewayPort, servername: WEB_HOST, ca: webTls.cert }, () => {
      const headers = { ...req.headers, 'x-forwarded-for': forwardedFor(req) };
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]));
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => terminator.listen(0, '127.0.0.1', () => {
    terminatorPort = (terminator.address() as { port: number }).port;
    resolve();
  }));
}

/** A request to the web hostname through the front door, from IPv4 or IPv6 loopback. */
function web(pathname: string, options: { from?: '127.0.0.1' | '::1'; method?: string; body?: string; headers?: Record<string, string> } = {})
  : Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: options.from ?? '127.0.0.1', port: frontPort, servername: WEB_HOST, ca: webTls.cert, method: options.method ?? 'GET', path: pathname,
      headers: { host: WEB_HOST, ...options.headers }, agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('Silo behind one front door on 443 (option 1)', { skip: hasGo ? false : 'no Go toolchain here' }, () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'silo-ingress-'));
    binary = path.join(dir, 'silo-agent');
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });

    cell = await createConnectCell();
    root = await cell.signIn('root@acme.example');
    const ca = await testAgentCa();
    const agentTls = await testEndpointTls(AGENT_HOST);
    webTls = await testEndpointTls(WEB_HOST);
    await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
    await writeFile(path.join(dir, 'agent-endpoint.pem'), agentTls.cert);
    await writeFile(path.join(dir, 'web.pem'), webTls.cert);
    await writeFile(path.join(dir, 'web.key'), webTls.key);
    await cell.start(createConnectRuntimeService({ onAgentEndpoint: (p) => { agentEndpointPort = p; }, agentHeartbeatMs: 200 }), 'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'agent-endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: agentTls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    });
    // The gateway with its own certificate (production requires one), one trusted hop, and a small per-address limit to count by.
    await cell.start(createGatewayService({ onListening: (p) => { gatewayPort = p; } }), 'gateway', 'test_app', {
      REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
      GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
      GATEWAY_TLS_CERT_FILE: path.join(dir, 'web.pem'), GATEWAY_TLS_KEY_FILE: path.join(dir, 'web.key'), GATEWAY_REQUESTS_PER_ADDRESS: '6',
      GATEWAY_HEARTBEAT_SECONDS: '1',
    });
    await startTerminator();
    await startFrontDoor();
  });

  after(async () => {
    agentProcess?.kill('SIGTERM');
    inspector?.close();
    front?.close();
    terminator?.close();
    await cell?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the agent enrols and holds its tunnel through the passthrough: its mutual TLS ends at the cell', async () => {
    const poolId = (await cell.client('gateway').call(createAgentPool, { body: { name: 'Behind the front door', environment: 'production' } }, cell.as(root))).id;
    const config = path.join(dir, 'agent.json');
    await writeFile(config, JSON.stringify({
      endpoint: `127.0.0.1:${frontPort}`, serverName: AGENT_HOST, endpointCaFile: path.join(dir, 'agent-endpoint.pem'), stateDir: path.join(dir, 'state'),
      name: 'front-door', connections: {},
    }));
    await chmod(config, 0o600);
    const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
    try {
      await run(binary, ['enrol', '-config', config, '-token', token]);
    } catch (error) {
      assert.fail(`enrol failed: ${String((error as { stdout?: string }).stdout ?? '')}`);
    }
    agentProcess = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: 'ignore' });
    const status = await waitFor(async () => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select status from connect.agents where pool_id = $1', [poolId]))).rows[0]?.status as string | undefined, (s) => s === 'healthy');
    assert.equal(status, 'healthy', 'the tunnel, which needs the agent\'s certificate, is up');
    assert.ok(routed.filter((n) => n === AGENT_HOST).length >= 2, 'enrolment and the tunnel both came through the front door by name');
  });

  test('an ingress that decrypts the agent\'s traffic is refused by the agent, which names who re-signed it', async () => {
    // The inspecting ingress's own certificate for the agent's hostname, under its own authority.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'inspector.key', '-out', 'inspector.pem', '-days', '1',
      '-subj', '/O=Corporate Inspection/CN=Inspection CA', '-addext', `subjectAltName=DNS:${AGENT_HOST}`], { cwd: dir, stdio: 'ignore' });
    inspector = createTlsServer({ cert: await readFile(path.join(dir, 'inspector.pem')), key: await readFile(path.join(dir, 'inspector.key')) }, (s) => s.end());
    await new Promise<void>((resolve) => inspector!.listen(0, '127.0.0.1', () => {
      inspectorPort = (inspector!.address() as { port: number }).port;
      resolve();
    }));
    inspectAgent = true;
    try {
      const poolId = (await cell.client('gateway').call(createAgentPool, { body: { name: 'Inspected', environment: 'production' } }, cell.as(root))).id;
      const config = path.join(dir, 'inspected.json');
      await writeFile(config, JSON.stringify({
        endpoint: `127.0.0.1:${frontPort}`, serverName: AGENT_HOST, endpointCaFile: path.join(dir, 'agent-endpoint.pem'), stateDir: path.join(dir, 'inspected-state'),
        name: 'inspected', connections: {},
      }));
      await chmod(config, 0o600);
      const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
      const refused = await run(binary, ['enrol', '-config', config, '-token', token]).then(() => '', (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`);
      assert.match(refused, /Corporate Inspection/, refused);
      assert.match(refused, /TLS-inspecting proxy/);
    } finally {
      inspectAgent = false;
    }
  });

  test('the web hostname, decrypted and re-encrypted: the gateway counts each client by the address the ingress saw, never one it was told', async () => {
    const options = '/api/v1/sso/options?organisationSlug=acme';
    const statuses = async (from: '127.0.0.1' | '::1', n: number, headers: Record<string, string> = {}) => {
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) out.push((await web(options, { from, headers })).status);
      return out;
    };
    // A fresh window for the count: the limit is per minute.
    await waitFor(async () => new Date().getSeconds(), (s) => s < 50, 15_000);
    assert.deepEqual(await statuses('127.0.0.1', 6), [200, 200, 200, 200, 200, 200]);
    assert.equal((await statuses('127.0.0.1', 1, { 'x-forwarded-for': '203.0.113.9' }))[0], 429, 'a client cannot choose its own address');
    assert.deepEqual(await statuses('::1', 2), [200, 200], 'another client is counted apart');
  });

  test('the live WebSocket upgrades through the front door', async () => {
    // A session from IPv6 loopback, whose count is low.
    const signedIn = await web('/api/v1/sessions', {
      from: '::1', method: 'POST', body: JSON.stringify({ organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD }),
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-silo-csrf': '1' },
    });
    assert.equal(signedIn.status, 201, signedIn.body);
    const setCookie = signedIn.headers['set-cookie'] ?? [];
    const cookie = setCookie.map((c) => new RegExp(`^${SESSION_COOKIE}=([^;]+);`).exec(c)?.[1]).find((c) => c !== undefined)!;
    // ws hands TLS options to its connection: the name the front door routes by.
    const ws = new WebSocket(`wss://[::1]:${frontPort}${LIVE_PATH}`, {
      servername: WEB_HOST, ca: webTls.cert, headers: { host: WEB_HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${cookie}` },
    } as WebSocket.ClientOptions);
    const opened = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', (e) => resolve(`error: ${e.message}`));
      ws.once('unexpected-response', (_req, res) => resolve(`refused: ${res.statusCode}`));
    });
    assert.equal(opened, 'open');
    const frame = await new Promise<string>((resolve) => ws.once('message', (data) => resolve(data.toString())));
    assert.ok(frame.length > 0, 'a frame from the gateway came back through it');
    ws.close();
  });
});
