// The gateway's routes for the wave 1 services (audit, notifications, billing, metering)
// and the payment provider's webhook, end to end through real HTTP: real credential,
// policy, auth and gateway processes on a fresh cell database, and one stub process
// serving the internal contracts those routes forward to. The stub records exactly what
// arrives (the context, the input, the idempotency key, the raw webhook bytes), so these
// tests check the gateway's part: the session, the policy decision, own-records scoping,
// and the raw body. The services themselves are tested in their own files.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { PAYMENT_SIGNATURE_HEADER } from '../../src/config/payments.config.ts';
import {
  listAuditEvents, listAuthEvents, listChainHeads, listPartitionSeals, readAuditChain,
} from '../../src/contracts/audit/read.contract.ts';
import { MAX_PAYMENT_EVENT_BYTES, receivePaymentEvent } from '../../src/contracts/billing/paymentEvent.contract.ts';
import { purchase } from '../../src/contracts/billing/purchase.contract.ts';
import { openBillingPortal, readBilling, startCheckout } from '../../src/contracts/billing/subscription.contract.ts';
import type { AnyContract } from '../../src/contracts/endpoint.contract.ts';
import { PUBLIC_ROUTES } from '../../src/contracts/gateway/routeTable.contract.ts';
import { readAllowance } from '../../src/contracts/metering/allowance.contract.ts';
import { engagementCost, listLedger } from '../../src/contracts/metering/ledger.contract.ts';
import { acknowledgeNotification, listNotifications, markNotificationRead } from '../../src/contracts/notify/notification.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { Health } from '../../src/infra/health.infra.ts';
import { route } from '../../src/infra/http.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { signPayload } from '../../src/infra/payments/stripe.infra.ts';
import { withTransaction, type RequestContext } from '../../src/infra/postgres.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createHttpServer, runProcess, type HttpServer, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://app.silo.test';
const WEBHOOK_SECRET = 'whsec_test_secret_value';
const HEX = '0'.repeat(64);
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

let h: Harness;
let app: pg.Client;
const processes: RunningProcess[] = [];
let stub: HttpServer;
let stubRedis: RedisStore;
let gateway: string;
let org: string;
const roles: Record<string, string> = {};
const invitations: { email: string; token: string }[] = [];

// ----------------------------------------------------------------------------- the stub services

interface Received { contract: string; request: RequestContext; input: unknown; idempotencyKey: string | undefined }
const received: Received[] = [];
const lastFor = (contract: AnyContract): Received | undefined => received.findLast((r) => r.contract === contract.id);

const notification = (membershipId: string) => ({
  id: uuidv7(), organisationId: org, recipientMembershipId: membershipId, automationRunActionId: null, approvalChainId: uuidv7(),
  findingId: null, simulationRunId: null, operatorAccessSessionId: null, receiptId: null, actionEventSubscriptionId: null, objectViewLayoutId: null, ontologyElementId: null, pipelineRunId: null, supportTicketMessageId: null, supportTicketId: null, kind: 'approval_waiting' as const, channel: 'in_app' as const,
  createdAt: new Date().toISOString(), deliveredAt: null, readAt: new Date().toISOString(), acknowledgeDueAt: null, acknowledgedAt: null,
});

function stubRoutes() {
  const results = new Map<string, unknown>();
  const answer = <C extends AnyContract>(contract: C, reply: (input: any, request: RequestContext) => unknown) =>
    route(contract, {
      handle: async (input, ctx) => {
        received.push({ contract: contract.id, request: ctx.request, input, idempotencyKey: ctx.idempotencyKey });
        const output = reply(input, ctx.request);
        if (contract.idempotency === 'keyed') results.set(ctx.idempotencyKey!, output);
        return output as never;
      },
      // A keyed operation replays its first result.
      ...(contract.idempotency === 'keyed'
        ? { resultRef: () => 'stub', replay: async (_ref: string | undefined, ctx: { idempotencyKey: string | undefined }) => results.get(ctx.idempotencyKey!) as never }
        : {}),
    });
  const period = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };
  return [
    answer(listAuditEvents, () => ({ events: [], nextCursor: null })),
    answer(listAuthEvents, () => ({ events: [], nextCursor: null })),
    answer(listChainHeads, () => ({ heads: [] })),
    answer(readAuditChain, () => ({ anchor: { chainSeq: '0', rowHash: HEX }, events: [], verification: { ok: true, count: 0, lastHash: HEX } })),
    answer(listPartitionSeals, () => ({ seals: [] })),
    answer(listNotifications, () => ({ notifications: [], nextCursor: null })),
    answer(markNotificationRead, (_input, request) => ({ notification: notification(request.membershipId!) })),
    answer(acknowledgeNotification, (_input, request) => ({ notification: { ...notification(request.membershipId!), acknowledgedAt: new Date().toISOString() } })),
    answer(readBilling, () => ({ billingStatus: 'active', subscription: null, entitlement: null, invoices: [] })),
    answer(startCheckout, () => ({ checkoutId: 'cs_test_1', checkoutUrl: 'https://pay.example/checkout/1' })),
    answer(openBillingPortal, () => ({ portalUrl: 'https://pay.example/portal/1' })),
    answer(purchase, (input) => ({ purchaseId: uuidv7(), kind: input.body.kind, quantity: input.body.quantity, amount: '20.00', currency: 'GBP' })),
    answer(readAllowance, () => ({ period, tokens: null, simulations: null, balance: { autoTopup: false, onboardingGrantRemaining: 200, purchasedRemaining: 0, simulationsPurchasedRemaining: '0' } })),
    answer(listLedger, () => ({ transactions: [], next: null })),
    answer(engagementCost, (input) => ({ engagementId: input.params.engagementId, lines: [], tokensCharged: '0', simulationsCharged: '0',
      modelCost: { calls: 0, priced: 0, amount: '0.00000000', measured: false } })),
    // As billing does: the signature over exactly the bytes the provider sent.
    answer(receivePaymentEvent, (input) => {
      const timestamp = Number(/t=(\d+)/.exec(input.body.signature)?.[1]);
      if (signPayload(input.body.payload, WEBHOOK_SECRET, timestamp) !== input.body.signature) throw new Error('signature mismatch');
      return { outcome: 'applied' };
    }),
  ];
}

// ----------------------------------------------------------------------------- processes

const env = (service: string, extra: Record<string, string>): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', ...extra,
});

before(async () => {
  h = await createHarness();
  const migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  org = created.organisationId;
  const { rows } = await inTx(app, { orgId: org }, () => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;

  const pg = (login: 'test_auth' | 'test_credential' | 'test_app') => ({ PG_CONTROL_URL: h.url(login), REDIS_SESSION_URL: `${LOCAL.redisUrl}/0` });
  const credential = await runProcess([credentialService], env('credential', {
    ...pg('test_credential'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', pg('test_app')), { logger: quiet });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver(invitation) { invitations.push({ email: invitation.email, token: invitation.token }); } },
    resetDelivery: { async deliver() { /* not used here */ } },
  })], env('auth', {
    ...pg('test_auth'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1', LOGIN_ATTEMPTS_PER_ADDRESS: '1000', LOGIN_ATTEMPTS_PER_EMAIL: '1000',
    SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  }), { logger: quiet });
  processes.push(auth, policy, credential);

  // The stub: one listener serving audit, notify, billing and metering contracts.
  const stubConfig = env('policy', pg('test_app'));
  stubRedis = await connectRedis('data', { ...stubConfig.redis, data: `${LOCAL.redisUrl}/1` });
  stub = createHttpServer({
    services: ['audit', 'notify', 'billing', 'metering'], cellId: CELL_ID, environment: 'test', http: stubConfig.http,
    logger: quiet, health: new Health(), routes: stubRoutes(), idempotency: stubRedis,
  });
  const stubUrl = `http://127.0.0.1:${(await stub.listen()).port}`;

  let port = 0;
  processes.unshift(await runProcess([createGatewayService({ onListening: (p) => { port = p; } })], env('gateway', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    SERVICE_URL_AUTH: `http://127.0.0.1:${auth.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
    SERVICE_URL_AUDIT: stubUrl, SERVICE_URL_NOTIFY: stubUrl, SERVICE_URL_BILLING: stubUrl, SERVICE_URL_METERING: stubUrl,
  }), { logger: quiet }));
  gateway = `http://127.0.0.1:${port}`;

  root = await signIn('root@acme.example');
  member = await newMember('member@acme.example');
});

after(async () => {
  for (const p of processes) await p.stop('test');
  await stub?.close(1_000);
  await stubRedis?.close();
  await h?.close();
});

// ----------------------------------------------------------------------------- a browser

let addresses = 0;
interface Browser { cookie: string | undefined; address: string; session?: any }
const browser = (): Browser => ({ cookie: undefined, address: `203.0.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}` });

interface Reply { status: number; body: any; text: string }

async function call(who: Browser | undefined, method: string, path: string, options: {
  body?: unknown; headers?: Record<string, string>;
} = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': who?.address ?? '203.0.200.1', ...options.headers };
  if (method !== 'GET') {
    headers['origin'] = ORIGIN;
    headers['x-silo-csrf'] = '1';
  }
  if (who?.cookie) headers['cookie'] = `${SESSION_COOKIE}=${who.cookie}`;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${gateway}/api/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
  const text = await res.text();
  for (const cookie of res.headers.getSetCookie()) {
    const match = /^__Host-silo_session=([^;]*);.*Max-Age=(\d+)$/.exec(cookie);
    if (match && who) who.cookie = match[2] === '0' ? undefined : match[1];
  }
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), text };
}

async function signIn(email: string): Promise<Browser> {
  const who = browser();
  const reply = await call(who, 'POST', '/sessions', { body: { organisationSlug: 'acme', email, password: PASSWORD } });
  assert.equal(reply.status, 201, reply.text);
  return Object.assign(who, { session: reply.body });
}

async function newMember(email: string): Promise<Browser> {
  const invited = await call(root, 'POST', '/invitations', { body: { email, roleId: roles['Member'] }, headers: { 'idempotency-key': `k-${uuidv7()}` } });
  assert.equal(invited.status, 201, invited.text);
  const who = browser();
  const accepted = await call(who, 'POST', '/invitations/accept', {
    body: { organisationSlug: 'acme', token: invitations.findLast((i) => i.email === email)!.token, password: PASSWORD, firstName: 'New', lastName: 'Member' },
  });
  assert.equal(accepted.status, 201, accepted.text);
  return Object.assign(who, { session: accepted.body });
}

let root: Browser;
let member: Browser;

// ----------------------------------------------------------------------------- tests

describe('the routing table', () => {
  test('every wave 1 browser endpoint has a route; every complete-session route names exactly one of a permission, its own records, or why its service decides', () => {
    const names = PUBLIC_ROUTES.map((r) => r.name);
    for (const name of ['listAuditEvents', 'listAuthEvents', 'listChainHeads', 'readAuditChain', 'listPartitionSeals', 'listNotifications',
      'markNotificationRead', 'acknowledgeNotification', 'readBilling', 'startCheckout', 'openBillingPortal', 'purchase', 'readOwnAllowance',
      'readMemberAllowance', 'listTokenLedger', 'readEngagementCost', 'paymentWebhook']) {
      assert.ok(names.includes(name), name);
    }
    for (const r of PUBLIC_ROUTES.filter((x) => x.session === 'complete')) {
      assert.equal([r.permission !== undefined, r.ownRecords, r.decidedByService !== undefined].filter(Boolean).length, 1, r.id);
    }
  });
});

describe('audit', () => {
  test('audit.read holders read events, sign-ins and chain heads; others are refused before anything is forwarded', async () => {
    const before = received.length;
    for (const path of ['/audit/events', '/audit/auth-events', '/audit/chain-heads']) {
      const refused = await call(member, 'GET', path);
      assert.equal(refused.status, 403, refused.text);
      assert.equal(refused.body.error.code, 'gateway.not_permitted');
    }
    assert.equal(received.length, before, 'nothing reached the audit service');
    const events = await call(root, 'GET', '/audit/events?event=login&limit=10');
    assert.equal(events.status, 200, events.text);
    assert.deepEqual(events.body, { events: [], nextCursor: null });
    const arrived = lastFor(listAuditEvents)!;
    assert.deepEqual(arrived.input, { params: {}, query: { event: 'login', limit: 10 }, body: undefined });
    assert.equal(arrived.request.organisationId, org);
    assert.equal(arrived.request.membershipId, root.session.membershipId);
    assert.equal((await call(root, 'GET', '/audit/auth-events')).status, 200);
    assert.equal((await call(root, 'GET', '/audit/chain-heads')).status, 200);
  });

  test('a run of the chain and the seals need audit.export', async () => {
    assert.equal((await call(member, 'GET', '/audit/chain')).status, 403);
    const chain = await call(root, 'GET', '/audit/chain?afterChainSeq=5');
    assert.equal(chain.status, 200, chain.text);
    assert.equal((lastFor(readAuditChain)!.input as { query: { afterChainSeq: string } }).query.afterChainSeq, '5');
    assert.equal((await call(root, 'GET', '/audit/seals')).status, 200);
  });

  test('the browser cannot widen the query: unknown parameters are refused', async () => {
    const reply = await call(root, 'GET', '/audit/events?organisationId=00000000-0000-7000-8000-000000000000');
    assert.equal(reply.status, 400);
    assert.equal(reply.body.error.code, 'contract.request_invalid');
  });
});

describe('own records', () => {
  test('a member lists, reads and acknowledges their own notifications: no permission, the membership from the session', async () => {
    const list = await call(member, 'GET', '/notifications?unread=true&limit=5');
    assert.equal(list.status, 200, list.text);
    const listed = lastFor(listNotifications)!;
    assert.deepEqual(listed.input, { params: {}, query: { unread: true, limit: 5 }, body: undefined });
    assert.equal(listed.request.membershipId, member.session.membershipId);
    const id = uuidv7();
    const read = await call(member, 'POST', `/notifications/${id}/read`);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.notification.recipientMembershipId, member.session.membershipId);
    assert.deepEqual((lastFor(markNotificationRead)!.input as { params: unknown }).params, { notificationId: id });
    const acknowledged = await call(member, 'POST', `/notifications/${id}/acknowledgement`, { body: {} });
    assert.equal(acknowledged.status, 200, acknowledged.text);
    assert.ok(acknowledged.body.notification.acknowledgedAt !== null);
  });

  test('a forged identity header is ignored: the context is the session\'s', async () => {
    await call(member, 'GET', '/notifications', { headers: { 'x-silo-membership-id': root.session.membershipId } });
    assert.equal(lastFor(listNotifications)!.request.membershipId, member.session.membershipId);
  });

  test('a member reads their own allowance; another member\'s needs billing.view', async () => {
    const own = await call(member, 'GET', '/allowance');
    assert.equal(own.status, 200, own.text);
    assert.deepEqual((lastFor(readAllowance)!.input as { params: unknown }).params, { membershipId: member.session.membershipId });
    assert.equal((await call(member, 'GET', `/members/${root.session.membershipId}/allowance`)).status, 403);
    const other = await call(root, 'GET', `/members/${member.session.membershipId}/allowance`);
    assert.equal(other.status, 200, other.text);
    assert.deepEqual((lastFor(readAllowance)!.input as { params: unknown }).params, { membershipId: member.session.membershipId });
  });

  test('no session, no own records', async () => {
    const reply = await call(undefined, 'GET', '/notifications');
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error.code, 'gateway.session_required');
  });
});

describe('billing and tokens', () => {
  test('the billing page needs billing.view; checkout and the portal need billing.manage', async () => {
    assert.equal((await call(member, 'GET', '/billing')).status, 403);
    assert.deepEqual((await call(root, 'GET', '/billing')).body, { billingStatus: 'active', subscription: null, entitlement: null, invoices: [] });
    assert.equal((await call(member, 'POST', '/billing/portal')).status, 403);
    const opened = await call(root, 'POST', '/billing/portal');
    assert.equal(opened.status, 201, opened.text);
    assert.equal(opened.body.portalUrl, 'https://pay.example/portal/1');
  });

  test('checkout and purchases are keyed: the browser\'s key is forwarded under the membership; without one they are refused', async () => {
    const missing = await call(root, 'POST', '/billing/checkout', { body: { plan: 'business', term: 'annual', seats: 10 } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'idempotency.key_missing');
    const key = `checkout-${randomBytes(8).toString('hex')}`;
    const started = await call(root, 'POST', '/billing/checkout', { body: { plan: 'business', term: 'annual', seats: 10 }, headers: { 'idempotency-key': key } });
    assert.equal(started.status, 201, started.text);
    assert.equal(lastFor(startCheckout)!.idempotencyKey, `${root.session.membershipId}.${key}`);
    const bought = await call(root, 'POST', '/purchases', { body: { kind: 'tokens', quantity: 100 }, headers: { 'idempotency-key': `buy-${randomBytes(8).toString('hex')}` } });
    assert.equal(bought.status, 201, bought.text);
    assert.deepEqual([bought.body.kind, bought.body.quantity], ['tokens', 100]);
  });

  test('the token ledger and an engagement\'s cost need billing.view', async () => {
    assert.equal((await call(member, 'GET', '/token-ledger')).status, 403);
    assert.equal((await call(root, 'GET', '/token-ledger?limit=20')).status, 200);
    const engagementId = uuidv7();
    const cost = await call(root, 'GET', `/engagements/${engagementId}/cost`);
    assert.equal(cost.status, 200, cost.text);
    assert.equal(cost.body.engagementId, engagementId);
  });
});

describe('the payment provider\'s webhook', () => {
  const hook = (body: Buffer | string, headers: Record<string, string>) =>
    fetch(`${gateway}/api/v1/hooks/payments`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.250.1', ...headers }, body });
  const signed = (payload: string) => signPayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

  test('the raw body and the signature header reach billing exactly as sent: no session, no Origin, no CSRF header', async () => {
    // Whitespace, key order and a non-ASCII character a re-serialisation would change.
    const payload = '{ "type":"invoice.paid",  "id":"evt_1", "data": {"object": {"note": "Café £20"}}}\n';
    const res = await hook(payload, { 'content-type': 'application/json; charset=utf-8', [PAYMENT_SIGNATURE_HEADER]: signed(payload) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { received: true });
    const arrived = lastFor(receivePaymentEvent)!;
    assert.equal((arrived.input as { body: { payload: string } }).body.payload, payload);
    assert.deepEqual(arrived.request, {}, 'no session context');
  });

  test('any content type is taken as bytes', async () => {
    const payload = 'id=evt_2&type=ping';
    const res = await hook(payload, { 'content-type': 'text/plain', [PAYMENT_SIGNATURE_HEADER]: signed(payload) });
    assert.equal(res.status, 200);
  });

  test('refused: no signature, a browser\'s request, bytes that are not UTF-8, an oversize body', async () => {
    const payload = '{"id":"evt_3"}';
    const unsigned = await hook(payload, { 'content-type': 'application/json' });
    assert.equal(unsigned.status, 401);
    assert.equal(((await unsigned.json()) as { error: { code: string } }).error.code, 'gateway.webhook_unsigned');
    const fromBrowser = await hook(payload, { 'content-type': 'application/json', [PAYMENT_SIGNATURE_HEADER]: signed(payload), 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' });
    assert.equal(fromBrowser.status, 403);
    const binary = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const notText = await hook(binary, { 'content-type': 'application/octet-stream', [PAYMENT_SIGNATURE_HEADER]: 't=1,v1=00' });
    assert.equal(notText.status, 400);
    const huge = 'x'.repeat(MAX_PAYMENT_EVENT_BYTES + 1);
    const oversize = await hook(huge, { 'content-type': 'application/json', [PAYMENT_SIGNATURE_HEADER]: signed(huge) });
    assert.equal(oversize.status, 422, 'refused with the bound named, as every oversize body is');
    assert.equal(((await oversize.json()) as { error: { code: string } }).error.code, 'bound.request_body_bytes');
  });

  test('a bad signature fails inside billing; the provider learns only that it was not accepted', async () => {
    const payload = '{"id":"evt_4"}';
    const res = await hook(payload, { 'content-type': 'application/json', [PAYMENT_SIGNATURE_HEADER]: signed('{"id":"evt_other"}') });
    assert.ok(res.status >= 400);
    const body: unknown = await res.json();
    assert.ok(!JSON.stringify(body).includes('evt_'), 'nothing of the payload is echoed');
  });
});
