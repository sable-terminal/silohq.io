// The gateway end to end: credential, policy, auth and three gateways as real processes on
// a fresh cell database, Redis and NATS, driven like a browser (cookies, Origin, the
// custom header) over real HTTP and WebSockets. The state plane is a fake behind the
// subscription source; its frames are published on bus-live as the state plane will.
//
// The gateways: "main", with a fake state plane; "edge2", with the default (no state
// plane) and a low per-address limit; "edge3", whose auth service is unreachable.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import WebSocket from 'ws';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import {
  LIVE_PATH, liveGroupFrame, liveResyncRequest, type GroupFrame, type ServerFrame,
} from '../../src/contracts/gateway/live.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { connectLiveBus, liveSubjects, type LiveBus } from '../../src/infra/bus.infra.ts';
import { sessionKeys } from '../../src/infra/keyspaces.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import type { LiveHolder, SubscribeOutcome, SubscribeRequest, SubscriptionSource } from '../../src/services/gateway/subscriptionSource.service.ts';
import { base32Decode, totpCode, totpStep } from '../../src/utils/totp.util.ts';
import { issueSessionToken } from '../../src/utils/token.util.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://app.silo.test';
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
const processes: RunningProcess[] = [];
let main: string;
let edge2: string;
let edge3: string;
let edge2Process: RunningProcess;
let bus: LiveBus;
let sessions: RedisStore;
const invitations: { email: string; token: string }[] = [];
const resets: { email: string; token: string }[] = [];
let org: string;
let rootMembership: string;
const roles: Record<string, string> = {};
const scopes: Record<string, string> = {};

// ----------------------------------------------------------------------------- the fake state plane

type Respond = (holder: LiveHolder, request: SubscribeRequest) => Promise<SubscribeOutcome>;
const calls = {
  subscribe: [] as { holder: LiveHolder; request: SubscribeRequest }[],
  unsubscribe: [] as string[],
  renew: [] as { subscriptionId: string; ackedSeq: number | undefined }[],
};
let respond: Respond = async () => ({ outcome: 'refused', reason: 'unresolvable' });
const fakeStatePlane: SubscriptionSource = {
  subscribe: (holder, request) => {
    calls.subscribe.push({ holder, request });
    return respond(holder, request);
  },
  async unsubscribe(_holder, subscriptionId) {
    calls.unsubscribe.push(subscriptionId);
  },
  async renew(_holder, subscriptions) {
    calls.renew.push(...subscriptions);
  },
};

const publish = (group: string, frame: GroupFrame, subscription?: string): void =>
  bus.publish(liveGroupFrame, liveSubjects.subscription(org, group), { group, frame, ...(subscription ? { subscription } : {}) });

// ----------------------------------------------------------------------------- processes

const env = (service: string, extra: Record<string, string>): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', ...extra,
});

async function startGateway(extra: Record<string, string>, source?: SubscriptionSource): Promise<{ url: string; process: RunningProcess }> {
  let port = 0;
  const process = await runProcess([createGatewayService({
    ...(source ? { subscriptionSource: source } : {}),
    onListening: (p) => { port = p; },
  })], env('gateway', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    GATEWAY_HEARTBEAT_SECONDS: '1', GATEWAY_SESSION_CHECK_SECONDS: '1', ...extra,
  }), { logger: quiet });
  processes.unshift(process);
  return { url: `http://127.0.0.1:${port}`, process };
}

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  org = created.organisationId;
  rootMembership = created.membershipId;
  const { rows } = await inTx(app, { orgId: org }, () => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;
  const type = uuidv7();
  await inTx(app, { orgId: org }, async () => {
    await app.query('insert into iam.scope_types (id, organisation_id, name) values ($1, $2, $3)', [type, org, 'Department']);
    for (const [name, parent] of [['engineering', null], ['platform', 'engineering']] as const) {
      scopes[name] = uuidv7();
      await app.query(
        'insert into iam.scopes (id, organisation_id, scope_type_id, name, parent_scope_id, path, depth, created_by) values ($1, $2, $3, $4, $5, $6, 1, $7)',
        [scopes[name], org, type, name, parent ? scopes[parent] : null, 'x', created.membershipId]);
    }
  });

  const pg = (login: 'test_auth' | 'test_credential' | 'test_app') => ({ PG_CONTROL_URL: h.url(login), REDIS_SESSION_URL: `${LOCAL.redisUrl}/0` });
  const credential = await runProcess([credentialService], env('credential', {
    ...pg('test_credential'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', pg('test_app')), { logger: quiet });
  const authConfig = env('auth', {
    ...pg('test_auth'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1', LOGIN_ATTEMPTS_PER_ADDRESS: '1000', LOGIN_ATTEMPTS_PER_EMAIL: '1000',
    SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
    resetDelivery: { async deliver(reset) { resets.push({ email: reset.email, token: reset.token }); } },
  })], authConfig, { logger: quiet });
  processes.push(auth, policy, credential);
  const upstream = { SERVICE_URL_AUTH: `http://127.0.0.1:${auth.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}` };

  main = (await startGateway({ ...upstream, GATEWAY_REQUESTS_PER_SESSION: '40' }, fakeStatePlane)).url;
  const second = await startGateway({ ...upstream, GATEWAY_REQUESTS_PER_ADDRESS: '5' });
  edge2 = second.url;
  edge2Process = second.process;
  edge3 = (await startGateway({ SERVICE_URL_AUTH: 'http://127.0.0.1:9', SERVICE_URL_POLICY: 'http://127.0.0.1:9' })).url;

  bus = await connectLiveBus({ ...authConfig.bus, liveUrl: LOCAL.natsUrl }, 'test');
  sessions = await connectRedis('session', authConfig.redis);
});

after(async () => {
  await bus?.close();
  await sessions?.close();
  for (const p of processes) await p.stop('test');
  await h?.close();
});

// ----------------------------------------------------------------------------- a browser

let addresses = 0;
interface Browser { cookie: string | undefined; address: string }
const browser = (): Browser => ({ cookie: undefined, address: `198.51.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}` });

interface Reply { status: number; body: any; text: string; headers: Headers; setCookies: string[] }

async function call(who: Browser | undefined, method: string, path: string, options: {
  body?: unknown; rawBody?: string; contentType?: string; headers?: Record<string, string>; origin?: string | null; csrf?: boolean; base?: string;
} = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': who?.address ?? '198.51.200.1', ...options.headers };
  if (method !== 'GET') {
    if (options.origin !== null) headers['origin'] = options.origin ?? ORIGIN;
    if (options.csrf !== false) headers['x-silo-csrf'] = '1';
  }
  if (who?.cookie) headers['cookie'] = `theme=dark; ${SESSION_COOKIE}=${who.cookie}`;
  const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
  const res = await fetch(`${options.base ?? main}/api/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
  const text = await res.text();
  const setCookies = res.headers.getSetCookie();
  for (const cookie of setCookies) {
    const match = /^__Host-silo_session=([^;]*);.*Max-Age=(\d+)$/.exec(cookie);
    if (match && who) who.cookie = match[2] === '0' ? undefined : match[1];
  }
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), text, headers: res.headers, setCookies };
}

async function signIn(email: string, who = browser(), password = PASSWORD): Promise<Browser & { session: any }> {
  const reply = await call(who, 'POST', '/sessions', { body: { organisationSlug: 'acme', email, password } });
  assert.equal(reply.status, 201, reply.text);
  return Object.assign(who, { session: reply.body });
}

/** Invited by root through the gateway, accepted through the gateway: a signed-in browser. */
async function newMember(email: string, role: string, scope?: string): Promise<Browser & { session: any }> {
  const reply = await call(root, 'POST', '/invitations', {
    body: { email, roleId: roles[role], ...(scope ? { scopeId: scopes[scope] } : {}) }, headers: { 'idempotency-key': `k-${uuidv7()}` },
  });
  assert.equal(reply.status, 201, reply.text);
  const who = browser();
  const accepted = await call(who, 'POST', '/invitations/accept', {
    body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: 'New', lastName: 'Member' },
  });
  assert.equal(accepted.status, 201, accepted.text);
  return Object.assign(who, { session: accepted.body });
}

let root: Browser & { session: any };

// ----------------------------------------------------------------------------- a live client

interface Live {
  ws: WebSocket;
  frames: ServerFrame[];
  send(message: unknown): void;
  next<T extends ServerFrame['type']>(type: T, where?: (frame: Extract<ServerFrame, { type: T }>) => boolean, timeoutMs?: number)
    : Promise<Extract<ServerFrame, { type: T }>>;
  closed: Promise<{ code: number; reason: string }>;
}

type Opened = { ok: true; live: Live } | { ok: false; status: number; body: any };

function openLive(who: Browser, options: { origin?: string; base?: string } = {}): Promise<Opened> {
  const headers: Record<string, string> = { 'x-forwarded-for': who.address, origin: options.origin ?? ORIGIN };
  if (who.cookie) headers['cookie'] = `${SESSION_COOKIE}=${who.cookie}`;
  const ws = new WebSocket(`${(options.base ?? main).replace('http', 'ws')}${LIVE_PATH}`, { headers });
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      res.on('end', () => resolve({ ok: false, status: res.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) }));
    });
    ws.on('error', reject);
    ws.on('open', () => {
      const frames: ServerFrame[] = [];
      const waiters: (() => void)[] = [];
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        if (frame.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat' }));
        frames.push(frame);
        for (const wake of waiters.splice(0)) wake();
      });
      const closed = new Promise<{ code: number; reason: string }>((done) => {
        ws.on('close', (code, reason) => done({ code, reason: reason.toString() }));
      });
      // Each frame is taken once; frames of other types wait for their own next().
      const taken = new Set<number>();
      const live: Live = {
        ws, frames, closed,
        send: (message) => ws.send(JSON.stringify(message)),
        async next(type, where, timeoutMs = 5_000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            for (let i = 0; i < frames.length; i++) {
              const frame = frames[i]!;
              if (!taken.has(i) && frame.type === type && (where === undefined || where(frame as never))) {
                taken.add(i);
                return frame as never;
              }
            }
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`no ${type} frame within ${timeoutMs} ms`);
            await Promise.race([new Promise<void>((wake) => waiters.push(wake)), sleep(left)]);
          }
        },
      };
      resolve({ ok: true, live });
    });
  });
}

async function connected(who: Browser, options: { base?: string } = {}): Promise<Live> {
  const opened = await openLive(who, options);
  assert.ok(opened.ok, opened.ok ? '' : JSON.stringify(opened.body));
  return opened.live;
}

const subscribe = (live: Live, ref: string, extra: Record<string, unknown> = {}) => live.send({
  type: 'subscribe', ref, set: { kind: 'view', id: uuidv7() }, properties: ['status', 'flow', 'secret'], ...extra,
});

const at = () => new Date().toISOString();
const delta = (seq: number, object: string, changes: Record<string, string | number>, state?: string): GroupFrame => ({
  type: 'delta', seq, object, coalesced: 0,
  changes: Object.entries(changes).map(([property, value]) => ({ property, value, source: 'conn_a', receivedAt: at() })),
  ...(state === undefined ? {} : { state: { value: state, ruleVersion: 1, reason: 'Status reports trip or fault' } }),
});

// ----------------------------------------------------------------------------- HTTP

describe('the public edge (spec 7.3)', () => {
  before(async () => {
    root = await signIn('root@acme.example');
  });

  test('every response carries the security headers and a correlation id; nothing is cached', async () => {
    const reply = await call(root, 'GET', '/session');
    assert.equal(reply.status, 200);
    for (const [name, value] of [
      ['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'no-referrer'],
    ] as const) assert.equal(reply.headers.get(name), value, name);
    assert.match(reply.headers.get('content-security-policy')!, /default-src 'none'; frame-ancestors 'none'/);
    assert.match(reply.headers.get('strict-transport-security')!, /max-age=\d+/);
    assert.match(reply.headers.get('x-correlation-id')!, /^[0-9a-f-]{36}$/);
    assert.equal(reply.headers.get('x-powered-by'), null);
    assert.equal(reply.headers.get('access-control-allow-origin'), null);
    const missing = await call(root, 'GET', '/nowhere');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    const preflight = await fetch(`${main}/api/v1/sessions`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 403, 'no CORS beyond the one origin');
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });

  test('sign-in sets a host-only, HttpOnly, SameSite=Strict cookie and never returns the token', async () => {
    const who = browser();
    const reply = await call(who, 'POST', '/sessions', { body: { organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD } });
    assert.equal(reply.status, 201);
    const cookie = reply.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    assert.match(cookie, /^__Host-silo_session=silo_ses_[A-Za-z0-9_-]{86}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    assert.doesNotMatch(reply.text, /silo_ses_/, 'the token is in the cookie only');
    assert.equal(reply.body.membershipId, rootMembership);
    assert.equal((await call(who, 'GET', '/session')).body.sessionId, reply.body.sessionId);
  });

  test('cross-site state changes are refused: no Origin, another Origin, no custom header, cross-site fetch metadata, a form body', async () => {
    const body = { organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD };
    for (const options of [{ origin: null }, { origin: 'https://evil.example' }, { csrf: false }] as const) {
      const reply = await call(browser(), 'POST', '/sessions', { body, ...options });
      assert.equal(reply.status, 403);
      assert.equal(reply.body.error.code, 'gateway.cross_site');
      assert.equal(reply.setCookies.length, 0, 'no session is issued');
    }
    const crossSite = await call(root, 'GET', '/session', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.body.error.code, 'gateway.cross_site');
    const form = await call(browser(), 'POST', '/sessions', {
      rawBody: 'organisationSlug=acme&email=root%40acme.example', contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(form.body.error.code, 'request.content_type');
  });

  test('requests are validated against the route and bounded in size', async () => {
    const invalid = await call(browser(), 'POST', '/sessions', { body: { organisationSlug: 'acme', email: 'not-an-email', password: PASSWORD } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'contract.request_invalid');
    assert.ok(invalid.body.error.issues.some((i: { path: string }) => i.path === 'body.email'));
    assert.doesNotMatch(invalid.text, /correct horse/, 'values are never echoed');
    const extra = await call(browser(), 'POST', '/sessions', { body: { organisationSlug: 'acme', email: 'a@b.example', password: 'x', client: { address: '1.1.1.1' } } });
    assert.equal(extra.status, 400, 'the client cannot supply its own address');
    const big = await call(browser(), 'POST', '/sessions', { body: { organisationSlug: 'acme', email: 'a@b.example', password: 'x'.repeat(10_000) } });
    assert.equal(big.status, 422);
    assert.equal(big.body.error.code, 'bound.request_body_bytes');
  });

  test('a session is needed where the route says, and a cookie naming no live session is cleared', async () => {
    const none = await call(browser(), 'GET', '/session');
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, 'gateway.session_required');
    const forged: Browser = { cookie: issueSessionToken(org, uuidv7()).token, address: browser().address };
    const unknown = await call(forged, 'GET', '/session');
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, 'auth.session_invalid');
    assert.ok(unknown.setCookies.some((c) => /^__Host-silo_session=; .*Max-Age=0$/.test(c)));
    assert.equal(forged.cookie, undefined);
  });

  test('sign-out revokes the session and clears the cookie; signing in again ends the session the browser held', async () => {
    const who = await signIn('root@acme.example');
    const held: Browser = { cookie: who.cookie, address: who.address };
    const out = await call(who, 'DELETE', '/session');
    assert.equal(out.status, 204);
    assert.equal(who.cookie, undefined);
    assert.equal((await call(held, 'GET', '/session')).body.error.code, 'auth.session_invalid');

    const again = await signIn('root@acme.example');
    const first: Browser = { cookie: again.cookie, address: again.address };
    await signIn('root@acme.example', again);
    assert.notEqual(again.cookie, first.cookie);
    let status = 200;
    for (let i = 0; i < 20 && status === 200; i++, await sleep(50)) status = (await call(first, 'GET', '/session')).status;
    assert.equal(status, 401, 'the replaced session is revoked');
    assert.equal((await call(again, 'GET', '/session')).status, 200);
  });

  test('invitations: authorised by policy at the gateway, keyed per member, identity from the cookie alone', async () => {
    const key = `invite-${uuidv7()}`;
    const send = (who: Browser, email: string, idempotencyKey: string | undefined, headers: Record<string, string> = {}) => call(who, 'POST', '/invitations', {
      body: { email, roleId: roles['Admin'], scopeId: scopes['engineering'] },
      headers: { ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...headers },
    });
    const first = await send(root, 'eve@acme.example', key);
    assert.equal(first.status, 201, first.text);
    const retried = await send(root, 'eve@acme.example', key);
    assert.deepEqual(retried.body, first.body, 'a retried click returns the first invitation');
    assert.equal(invitations.filter((i) => i.email === 'eve@acme.example').length, 1, 'and sends one email');
    const { rows } = await migrate.query('select invited_by from iam.invitations where id = $1', [first.body.invitationId]);
    assert.equal(rows[0].invited_by, rootMembership);
    assert.equal((await send(root, 'eve2@acme.example', undefined)).body.error.code, 'idempotency.key_missing');

    const eve = browser();
    const accepted = await call(eve, 'POST', '/invitations/accept', {
      body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === 'eve@acme.example')!.token, password: PASSWORD, firstName: 'Eve', lastName: 'Admin' },
    });
    assert.equal(accepted.status, 201);
    assert.ok(eve.cookie, 'acceptance signs the person in with a cookie');
    assert.doesNotMatch(accepted.text, /silo_ses_/);

    const same = await call(eve, 'POST', '/invitations', {
      body: { email: 'max@acme.example', roleId: roles['Member'], scopeId: scopes['platform'] }, headers: { 'idempotency-key': key },
    });
    assert.equal(same.status, 201, 'another member\'s identical key is theirs, not a replay of root\'s');
    assert.notEqual(same.body.invitationId, first.body.invitationId);

    const member = await newMember('max2@acme.example', 'Member', 'platform');
    const spoofed = await call(member, 'POST', '/invitations', {
      body: { email: 'zoe@acme.example', roleId: roles['Member'], scopeId: scopes['platform'] },
      headers: { 'idempotency-key': `k-${uuidv7()}`, 'x-silo-membership-id': rootMembership, 'x-silo-organisation-id': org, 'x-silo-caller': 'auth' },
    });
    assert.equal(spoofed.status, 403);
    assert.equal(spoofed.body.error.code, 'gateway.not_permitted', 'the browser\'s headers are not identity');
    assert.equal(spoofed.body.error.details.reason, 'not_granted');
    assert.equal(spoofed.body.error.details.service, undefined);
  });

  test('an MFA-pending session reaches only the MFA routes', async () => {
    const mia = await newMember('mia@acme.example', 'Member', 'platform');
    const enrol = await call(mia, 'POST', '/mfa/totp');
    assert.equal(enrol.status, 201, enrol.text);
    const secret = base32Decode(new URL(enrol.body.otpauthUri).searchParams.get('secret')!);
    const step = totpStep();
    const confirmed = await call(mia, 'POST', '/mfa/totp/confirm', { body: { factorId: enrol.body.factorId, code: totpCode(secret, step) } });
    assert.equal(confirmed.body.mfa, 'satisfied');

    const pending = await signIn('mia@acme.example');
    assert.equal(pending.session.mfa, 'required');
    assert.equal((await call(pending, 'GET', '/session')).body.mfa, 'required', 'the session itself is an MFA route');
    const blocked = await call(pending, 'POST', '/invitations', {
      body: { email: 'x@acme.example', roleId: roles['Member'], scopeId: scopes['platform'] }, headers: { 'idempotency-key': `k-${uuidv7()}` },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'gateway.mfa_required');
    const socket = await openLive(pending);
    assert.ok(!socket.ok && socket.status === 403 && socket.body.error.code === 'gateway.mfa_required');

    const verified = await call(pending, 'POST', '/session/mfa', { body: { code: totpCode(secret, step + 1) } });
    assert.equal(verified.body.mfa, 'satisfied');
    const now = await call(pending, 'POST', '/invitations', {
      body: { email: 'x@acme.example', roleId: roles['Member'], scopeId: scopes['platform'] }, headers: { 'idempotency-key': `k-${uuidv7()}` },
    });
    assert.equal(now.body.error.code, 'gateway.not_permitted', 'past the MFA gate, policy decides');
  });

  test('password reset through the gateway', async () => {
    await newMember('rex@acme.example', 'Member', 'platform');
    const who = browser();
    const requested = await call(who, 'POST', '/password-resets', { body: { organisationSlug: 'acme', email: 'rex@acme.example' } });
    assert.equal(requested.status, 202);
    const token = resets.findLast((r) => r.email === 'rex@acme.example')!.token;
    const consumed = await call(who, 'POST', '/password-resets/consume', {
      body: { organisationSlug: 'acme', token, newPassword: 'a much longer passphrase 2026' },
    });
    assert.equal(consumed.status, 204);
    await signIn('rex@acme.example', browser(), 'a much longer passphrase 2026');
  });

  test('rate limits per session and per client address', async () => {
    const who = await signIn('root@acme.example');
    for (let i = 0; i < 40; i++) assert.equal((await call(who, 'GET', '/session')).status, 200);
    const limited = await call(who, 'GET', '/session');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'gateway.rate_limited.edge_session');
    assert.equal(limited.headers.get('retry-after'), '60');

    const visitor = browser();
    for (let i = 0; i < 5; i++) assert.equal((await call(visitor, 'GET', '/session', { base: edge2 })).status, 401);
    const shed = await call(visitor, 'GET', '/session', { base: edge2 });
    assert.equal(shed.status, 429);
    assert.equal(shed.body.error.code, 'gateway.rate_limited.edge_address');
    assert.equal((await call(browser(), 'GET', '/session', { base: edge2 })).status, 401, 'another address has its own window');
  });

  test('a failure inside the cell reaches the browser without its insides', async () => {
    const reply = await call(browser(), 'POST', '/sessions', { base: edge3, body: { organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD } });
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error.code, 'service.unreachable');
    assert.equal(reply.body.error.details, undefined);
    assert.doesNotMatch(reply.body.error.message, /auth|127\.0\.0\.1/);
  });
});

// ----------------------------------------------------------------------------- WebSocket

describe('the live WebSocket (spec 30.3)', () => {
  test('the handshake needs this origin and a live, complete session', async () => {
    const who = await signIn('root@acme.example');
    const foreign = await openLive(who, { origin: 'https://evil.example' });
    assert.ok(!foreign.ok && foreign.status === 403 && foreign.body.error.code === 'gateway.cross_site');
    const anonymous = await openLive(browser());
    assert.ok(!anonymous.ok && anonymous.status === 401 && anonymous.body.error.code === 'gateway.session_required');
    const live = await connected(who);
    assert.ok(await live.next('heartbeat'), 'the server heartbeats');
    live.ws.close();
  });

  test('subscribe: authorised, opened by the state plane, its snapshot routed even while the call is in flight', async () => {
    const who = await signIn('root@acme.example');
    const live = await connected(who);
    const group = uuidv7();
    respond = async (holder, request) => {
      assert.equal(holder.membershipId, rootMembership);
      publish(group, {
        type: 'snapshot', seq: 10, page: 0, last: true,
        objects: [{ object: 'o1', values: [{ property: 'status', value: 'RUN', source: 'conn_a', ageMs: 5 }, { property: 'secret', value: 's', source: 'conn_a', ageMs: 5 }] }],
      }, request.subscriptionId);
      await bus.flush();
      await sleep(100);
      return { outcome: 'subscribed', groupId: group, objectCount: 2, sources: ['conn_a'], fields: { granted: ['status', 'flow'], withheld: ['secret'] } };
    };
    subscribe(live, 'r1');
    const subscribed = await live.next('subscribed');
    assert.equal(subscribed.ref, 'r1');
    assert.deepEqual(subscribed.fields, { granted: ['status', 'flow'], withheld: ['secret'] });
    assert.equal(calls.subscribe.at(-1)!.request.subscriptionId, subscribed.sub);
    const snapshot = await live.next('snapshot');
    assert.equal(snapshot.sub, subscribed.sub);
    assert.deepEqual(snapshot.objects[0]!.values.map((v) => v.property), ['status'], 'withheld fields never leave the gateway');

    // Fan-out: coalesced within the window, transitions kept, withheld fields dropped.
    publish(group, delta(11, 'o1', { status: 'TRIP', secret: 'x' }));
    publish(group, delta(12, 'o1', { flow: 3 }));
    publish(group, delta(13, 'p1', { status: 'TRIP' }, 'failed'));
    publish(group, delta(14, 'p1', { status: 'RUN' }, 'normal'));
    publish(group, { type: 'membership', object: 'p9', change: 'left' });
    const coalesced = await live.next('delta', (d) => d.object === 'o1');
    assert.deepEqual([coalesced.seq, coalesced.coalesced], [12, 1]);
    assert.deepEqual(coalesced.changes.map((c) => c.property).sort(), ['flow', 'status']);
    assert.equal((await live.next('delta', (d) => d.object === 'p1')).state?.value, 'failed');
    assert.equal((await live.next('delta', (d) => d.object === 'p1')).state?.value, 'normal');
    assert.equal((await live.next('membership')).sub, subscribed.sub);
    assert.doesNotMatch(JSON.stringify(live.frames.filter((f) => f.type === 'delta' || f.type === 'snapshot')), /"secret"/);

    // Acknowledgements reach the state plane with the heartbeat; a gap asks for a resync.
    live.send({ type: 'ack', sub: subscribed.sub, seq: 14 });
    await live.next('heartbeat');
    await live.next('heartbeat');
    assert.ok(calls.renew.some((r) => r.subscriptionId === subscribed.sub && r.ackedSeq === 14));
    const resync = new Promise<unknown>((resolve) => {
      const stop = bus.subscribe(liveResyncRequest, liveSubjects.resync(org, group), (message) => { stop(); resolve(message); });
    });
    await bus.flush();
    live.send({ type: 'resync_required', sub: subscribed.sub, lastSeq: 14 });
    assert.deepEqual(await resync, { group, subscription: subscribed.sub, lastSeq: 14 });

    // Unsubscribe ends delivery.
    live.send({ type: 'unsubscribe', sub: subscribed.sub });
    assert.equal((await live.next('unsubscribe')).reason, 'requested');
    assert.ok(calls.unsubscribe.includes(subscribed.sub));
    const seen = live.frames.length;
    publish(group, delta(15, 'o1', { flow: 4 }));
    await sleep(500);
    assert.equal(live.frames.slice(seen).filter((f) => f.type === 'delta').length, 0);
    live.ws.close();
  });

  test('frames reach only the subscriptions of their group', async () => {
    const [a, b] = [await connected(await signIn('root@acme.example')), await connected(await signIn('root@acme.example'))];
    const [groupA, groupB] = [uuidv7(), uuidv7()];
    respond = async () => ({ outcome: 'subscribed', groupId: groupA, objectCount: 1, sources: [], fields: { granted: ['flow'], withheld: [] } });
    subscribe(a, 'a');
    const subA = await a.next('subscribed');
    respond = async () => ({ outcome: 'subscribed', groupId: groupB, objectCount: 1, sources: [], fields: { granted: ['flow'], withheld: [] } });
    subscribe(b, 'b');
    await b.next('subscribed');
    publish(groupA, delta(1, 'only-a', { flow: 1 }));
    publish(groupB, { type: 'source_status', sources: [{ source: 'conn_b', status: 'stale', ageMs: 180_000, reason: 'Agent heartbeat lost' }] });
    publish(groupA, delta(2, 'stray', { flow: 1 }), 's_not_a_subscription');
    assert.equal((await a.next('delta')).sub, subA.sub);
    assert.equal((await b.next('source_status')).sources[0]!.status, 'stale');
    await sleep(400);
    assert.equal(b.frames.filter((f) => f.type === 'delta').length, 0);
    assert.equal(a.frames.filter((f) => f.type === 'delta').length, 1, 'a frame addressed to another subscription is not delivered');
    a.ws.close();
    b.ws.close();
  });

  test('refusals say why: permission, a bound, or no state plane; never a silent partial subscription', async () => {
    const billing = await newMember('bill@acme.example', 'Billing');
    const live = await connected(billing);
    const before = calls.subscribe.length;
    subscribe(live, 'p');
    assert.equal((await live.next('refused')).reason, 'permission');
    assert.equal(calls.subscribe.length, before, 'the state plane is not asked for what policy denies');
    live.ws.close();

    const rootLive = await connected(await signIn('root@acme.example'));
    respond = async () => ({ outcome: 'refused', reason: 'bound', bound: 'objects_per_subscription', limit: 100_000, count: 250_000 });
    subscribe(rootLive, 'big');
    assert.deepEqual(await rootLive.next('refused'), { type: 'refused', ref: 'big', reason: 'bound', bound: 'objects_per_subscription', limit: 100_000, count: 250_000 });
    rootLive.ws.close();

    const edge = await connected(await signIn('root@acme.example', browser()), { base: edge2 });
    subscribe(edge, 'paused');
    assert.equal((await edge.next('refused')).reason, 'unavailable');
    edge.ws.close();
  });

  test('anything but a valid text message closes the socket', async () => {
    const who = await signIn('root@acme.example');
    const bad = await connected(who);
    bad.send({ type: 'subscribe', ref: 'x', set: { kind: 'view', id: 'not-a-uuid' }, properties: ['status'] });
    assert.equal((await bad.closed).code, 4400);
    const binary = await connected(who);
    binary.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await binary.closed).code, 1003);
  });

  test('only the person\'s own doing moves the idle clock; heartbeats and session checks do not', async () => {
    const who = await signIn('root@acme.example');
    const live = await connected(who);
    const key = sessionKeys.key(org, { sessionId: who.session.sessionId });
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    await sessions.setFields(sessionKeys, key, { idleExpiresAt: soon });
    await live.next('heartbeat');
    await live.next('heartbeat');
    await sleep(1_200);
    assert.equal((await sessions.readHash(sessionKeys, key))!.idleExpiresAt, soon, 'heartbeats and checks are not activity');
    respond = async () => ({ outcome: 'refused', reason: 'unresolvable' });
    subscribe(live, 'activity');
    await live.next('refused');
    assert.ok(Date.parse((await sessions.readHash(sessionKeys, key))!.idleExpiresAt) > Date.now() + 29 * 60_000, 'a subscribe slides it');
    live.ws.close();
  });

  test('a revoked session\'s sockets close within the check interval', async () => {
    const who = await signIn('root@acme.example');
    const live = await connected(who);
    const copy: Browser = { cookie: who.cookie, address: who.address };
    assert.equal((await call(copy, 'DELETE', '/session')).status, 204);
    const started = Date.now();
    assert.equal((await live.closed).code, 4401);
    assert.ok(Date.now() - started < 5_000);
  });

  test('stopping the gateway closes its sockets as going away, so clients reconnect', async () => {
    const live = await connected(await signIn('root@acme.example', browser()), { base: edge2 });
    await edge2Process.stop('test');
    assert.equal((await live.closed).code, 1001);
  });
});
