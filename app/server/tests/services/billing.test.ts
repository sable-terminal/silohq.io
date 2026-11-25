// The billing service (spec 71, 74, 75) end to end: credential, auth, policy, metering and
// billing as real processes on a fresh cell database, against a local fake of the payment
// provider's API that keeps the provider's idempotency and signs webhooks with its scheme.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import pg from 'pg';
import { ConfigError, loadConfig, type Config } from '../../src/config/index.config.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import { receivePaymentEvent } from '../../src/contracts/billing/paymentEvent.contract.ts';
import { purchase } from '../../src/contracts/billing/purchase.contract.ts';
import { setBillingStatus } from '../../src/contracts/billing/staff.contract.ts';
import { openBillingPortal, readBilling, startCheckout } from '../../src/contracts/billing/subscription.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { signPayload } from '../../src/infra/payments/stripe.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { createBillingService } from '../../src/routes/billing/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createMeteringService } from '../../src/routes/metering/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { discountTier, periodCovered } from '../../src/services/billing/plans.service.ts';
import { isAppError } from '../../src/utils/errors.util.ts';
import { CELL_ID, createLocalCell, createMembership, createUser } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { releaseSeat } from '../../src/contracts/auth/seats.contract.ts';
import { buySeats } from '../../src/contracts/billing/seats.contract.ts';
import { setAutoTopup } from '../../src/contracts/metering/autoTopup.contract.ts';
import { readAllowance } from '../../src/contracts/metering/allowance.contract.ts';
import { charge } from '../../src/contracts/metering/charge.contract.ts';
import { freePort } from './writeback.helper.ts';

const PASSWORD = 'correct horse battery staple';
const API_KEY = 'sk_test_fake_key_1234';
const WEBHOOK_SECRET = 'whsec_test_secret_5678';
const PRICES = { standard: 'price_std_m', business: 'price_biz_m' };

// ----------------------------------------------------------------------------- the fake provider

type Json = Record<string, unknown>;

interface Recorded { method: string; path: string; form: Record<string, string>; key: string | undefined; auth: string | undefined }

interface FakeProvider {
  url: string;
  requests: Recorded[];
  subscriptions: Map<string, Json>;
  decline: boolean;
  close(): Promise<void>;
}

async function startFakeProvider(): Promise<FakeProvider> {
  const requests: Recorded[] = [];
  const subscriptions = new Map<string, Json>();
  const objects = new Map<string, Json>();
  const replies = new Map<string, { status: number; body: Json }>();
  let n = 0;
  const fake: Partial<FakeProvider> = { requests, subscriptions, decline: false };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const form = Object.fromEntries(new URLSearchParams(req.method === 'GET' ? url.search : Buffer.concat(chunks).toString('utf8')));
      const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      requests.push({ method: req.method!, path: url.pathname, form, key, auth: req.headers.authorization });
      const send = (status: number, body: Json): void => {
        if (key !== undefined) replies.set(key, { status, body });
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      // The provider's idempotency: a repeated key returns the first reply.
      const cached = key === undefined ? undefined : replies.get(key);
      if (cached) {
        res.writeHead(cached.status, { 'content-type': 'application/json' }).end(JSON.stringify(cached.body));
        return;
      }
      if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { error: { type: 'invalid_request_error', message: 'no key' } });
      const id = (prefix: string): string => `${prefix}_${++n}`;
      const metadata = (prefix = 'metadata') => Object.fromEntries(Object.entries(form)
        .filter(([k]) => k.startsWith(`${prefix}[`) && k.split('[').length === prefix.split('[').length + 1)
        .map(([k, v]) => [k.slice(prefix.length + 1, -1), v]));
      const path = url.pathname;
      let m: RegExpExecArray | null;
      if (req.method === 'POST' && path === '/v1/customers') {
        const customer = { id: id('cus'), object: 'customer', name: form['name'], metadata: metadata() };
        objects.set(customer.id, customer);
        return send(200, customer);
      }
      if (req.method === 'GET' && (m = /^\/v1\/(customers|checkout\/sessions)\/(\w+)$/.exec(path))) {
        const found = objects.get(m[2]!);
        return found ? send(200, found) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
      }
      if (req.method === 'POST' && path === '/v1/checkout/sessions') {
        const sessionId = id('cs');
        const session = { id: sessionId, object: 'checkout.session', url: `https://checkout.example/c/${sessionId}`, customer: form['customer'] };
        objects.set(sessionId, session);
        return send(200, session);
      }
      if (req.method === 'POST' && path === '/v1/billing_portal/sessions') {
        return send(200, { id: id('bps'), url: `https://portal.example/p/${n}`, customer: form['customer'] });
      }
      if (req.method === 'GET' && (m = /^\/v1\/subscriptions\/(\w+)$/.exec(path))) {
        const found = subscriptions.get(m[1]!);
        return found ? send(200, found) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
      }
      // A seat count change on the subscription's one item.
      if (req.method === 'POST' && (m = /^\/v1\/subscriptions\/(\w+)$/.exec(path))) {
        const found = subscriptions.get(m[1]!);
        if (!found) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
        const item = (found['items'] as { data: Json[] }).data[0]!;
        if (form['items[0][id]'] !== item['id']) return send(400, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
        item['quantity'] = Number(form['items[0][quantity]']);
        return send(200, found);
      }
      if (req.method === 'POST' && path === '/v1/invoices') {
        const invoice = { id: id('in'), object: 'invoice', status: 'draft', customer: form['customer'], metadata: metadata() };
        objects.set(invoice.id, invoice);
        return send(200, invoice);
      }
      if (req.method === 'POST' && path === '/v1/invoiceitems') {
        if (!objects.has(form['invoice'] ?? '')) return send(400, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
        return send(200, { id: id('ii'), object: 'invoiceitem', amount: Number(form['amount']) });
      }
      if (req.method === 'POST' && (m = /^\/v1\/invoices\/(\w+)\/(finalize|pay|void)$/.exec(path))) {
        const invoice = objects.get(m[1]!);
        if (!invoice) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
        if (m[2] === 'pay' && fake.decline) {
          return send(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card was declined.' } });
        }
        invoice['status'] = m[2] === 'finalize' ? 'open' : m[2] === 'pay' ? 'paid' : 'void';
        return send(200, invoice);
      }
      return send(404, { error: { type: 'invalid_request_error', code: 'unknown_path' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake as FakeProvider;
}

// ----------------------------------------------------------------------------- the cell

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let provider: FakeProvider;
const processes: RunningProcess[] = [];
let gateway: ServiceClient;
let portal: ServiceClient;
let compile: ServiceClient;
let meteringUrl = '';
let billingConfig: Config;
const consumer = `metering-b${randomBytes(4).toString('hex')}`;
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

let org: string;
let root: { membershipId: string; sessionId: string };
let member: string;
const SUBSCRIPTION = `sub_${randomBytes(6).toString('hex')}`;

const env = (service: string, url: string, extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: url,
  REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, ...extra,
});

const asOrg = <T>(work: () => Promise<T>): Promise<T> => inTx(app, { orgId: org }, work);
const rows = async (sql: string, params: unknown[] = []) => (await asOrg(() => app.query(sql, params))).rows;
const events = async (name: string): Promise<Json[]> => (await rows(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by id`,
  [org, name])).map((r) => r.payload as Json);
const status = async (): Promise<string> => (await rows('select billing_status as s from iam.organisations where id = $1', [org]))[0]!.s;
const person = () => ({ request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });

async function refusedWith(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isAppError(error), 'an AppError');
    assert.equal(error.code, code);
    return { ...error.details, category: error.category };
  }
  throw new assert.AssertionError({ message: `expected ${code}` });
}

// The provider's subscription as its API returns it.
function providerSubscription(changes: { status?: string; price?: string; quantity?: number; organisationId?: string; cellId?: string } = {}): Json {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: SUBSCRIPTION, object: 'subscription', customer: 'cus_1', status: changes.status ?? 'active', canceled_at: null,
    items: { data: [{ id: 'si_1', price: { id: changes.price ?? PRICES.business }, quantity: changes.quantity ?? 10,
      current_period_start: now - 86_400, current_period_end: now + 29 * 86_400 }] },
    metadata: { organisation_id: changes.organisationId ?? org, cell_id: changes.cellId ?? CELL_ID },
  };
}

let eventNumber = 0;
async function deliver(type: string, object: Json, options: { signedAt?: number; secret?: string } = {}) {
  const payload = JSON.stringify({ id: `evt_${++eventNumber}`, object: 'event', type, data: { object } });
  const signature = signPayload(payload, options.secret ?? WEBHOOK_SECRET, options.signedAt ?? Math.floor(Date.now() / 1000));
  return gateway.call(receivePaymentEvent, { body: { payload, signature } });
}

/** The provider's state changes, then it tells billing. */
async function subscriptionChanges(changes: Parameters<typeof providerSubscription>[0] = {}, type = 'customer.subscription.updated') {
  const object = providerSubscription(changes);
  provider.subscriptions.set(SUBSCRIPTION, object);
  return deliver(type, object);
}

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');

  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' }));
  org = created.organisationId;
  member = await createMembership(app, org, await createUser(auth, 'member@acme.example'));

  provider = await startFakeProvider();
  // Billing calls metering (credits) and metering calls billing (auto top-up), and auth calls
  // billing after a seat is released: billing's address is chosen before anything starts.
  const billingPort = await freePort();
  const billingUrl = `http://127.0.0.1:${billingPort}`;
  const credential = await runProcess([credentialService], env('credential', h.url('test_credential'), {
    KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', h.url('test_app')), { logger: quiet });
  const policyUrl = `http://127.0.0.1:${policy.port}`;
  const authProcess = await runProcess([createAuthService()], env('auth', h.url('test_auth'), {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024',
    ARGON2_PASSES: '1', SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: policyUrl,
    SERVICE_URL_BILLING: billingUrl,
  }), { logger: quiet });
  const metering = await runProcess([createMeteringService({ consumer })], env('metering', h.url('test_app'), {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl, SERVICE_URL_POLICY: policyUrl,
    SERVICE_URL_BILLING: billingUrl,
  }), { logger: quiet });
  meteringUrl = `http://127.0.0.1:${metering.port}`;
  billingConfig = env('billing', h.url('test_billing'), {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, SERVICE_URL_POLICY: policyUrl, SERVICE_URL_METERING: `http://127.0.0.1:${metering.port}`,
    PAYMENTS_API_URL: provider.url, PAYMENTS_API_KEY: API_KEY, PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYMENTS_PRICE_STANDARD_MONTHLY: PRICES.standard, PAYMENTS_PRICE_BUSINESS_MONTHLY: PRICES.business,
    HTTP_PORT: String(billingPort), BILLING_AUTO_TOPUPS_PER_DAY: '1',
  });
  const billing = await runProcess([createBillingService()], billingConfig, { logger: quiet });
  processes.push(billing, metering, authProcess, policy, credential);

  const urls = { auth: `http://127.0.0.1:${authProcess.port}`, billing: `http://127.0.0.1:${billing.port}`, metering: meteringUrl };
  gateway = createServiceClient({ caller: 'gateway', http: { ...billingConfig.http, serviceUrls: urls } });
  compile = createServiceClient({ caller: 'compile', http: { ...billingConfig.http, serviceUrls: urls } });
  portal = createServiceClient({ caller: 'admin-portal', http: { ...billingConfig.http, serviceUrls: urls } });
  const signed = await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD } });
  root = { membershipId: signed.membershipId, sessionId: signed.sessionId };
});

after(async () => {
  gateway?.close();
  portal?.close();
  compile?.close();
  for (const p of processes) await p.stop('test');
  await provider?.close();
  const nc = await connect({ servers: LOCAL.natsUrl }).catch(() => undefined);
  if (nc) {
    await (await jetstreamManager(nc)).consumers.delete('SILO_DURABLE', `${consumer}-metering-usage`).catch(() => undefined);
    await nc.close();
  }
  await h?.close();
});

// ----------------------------------------------------------------------------- tests

describe('commercial rules (spec 72.1, 74.6)', () => {
  test('the seat discount ladder; 500 and above is quoted', () => {
    assert.deepEqual([1, 24, 25, 99, 100, 249, 250, 499, 500].map(discountTier),
      ['list', 'list', 'tier_25_99', 'tier_25_99', 'tier_100_249', 'tier_100_249', 'tier_250_499', 'tier_250_499', 'quoted']);
  });

  test('an invoice covers a month, or a range for an annual term', () => {
    assert.equal(periodCovered('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'), '2026-11');
    assert.equal(periodCovered('2026-11-01T00:00:00Z', '2027-11-01T00:00:00Z'), '2026-11/2027-10');
  });
});

describe('compiled out of the sovereign cell (spec 7)', () => {
  test('the configuration refuses billing in a build without the payment capability', () => {
    try {
      loadConfig({
        SILO_ENV: 'test', SILO_SERVICE: 'billing', SILO_CELL_ID: 'uk-sov-1', SILO_CELL_KIND: 'sovereign', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
        SILO_BUILD_TARGET: 'sovereign', SILO_APPROVED_CAPABILITIES: '', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0',
        PG_CONTROL_URL: 'postgres://x@127.0.0.1/x', REDIS_SESSION_URL: LOCAL.redisUrl, REDIS_DATA_URL: LOCAL.redisUrl,
        PAYMENTS_API_KEY: API_KEY, PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      });
      assert.fail('expected a configuration refusal');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.problems.some((p) => p.startsWith('SILO_SERVICES: billing is not in this build')), error.problems.join('; '));
    }
  });

  test('and the service itself refuses to start there', async () => {
    const sovereign = { ...billingConfig, cell: { ...billingConfig.cell, capabilities: new Set(['siloes_capture'] as const) } } as Config;
    await assert.rejects(runProcess([createBillingService()], sovereign, { logger: quiet }), (error: unknown) =>
      isAppError(error) && error.code === 'config.billing.not_in_build');
  });
});

describe('self-serve checkout (spec 71.3, 74.5)', () => {
  test('opens the provider checkout for a plan, term and seats; the tenant rides in the metadata', async () => {
    const key = uuidv7();
    const started = await gateway.call(startCheckout, { body: { plan: 'business', term: 'monthly', seats: 10 } }, { ...person(), idempotencyKey: key });
    assert.match(started.checkoutUrl, /^https:\/\/checkout\.example\/c\//);
    const customer = provider.requests.find((r) => r.path === '/v1/customers')!;
    assert.deepEqual([customer.form['metadata[organisation_id]'], customer.form['metadata[cell_id]'], customer.auth],
      [org, CELL_ID, `Bearer ${API_KEY}`]);
    const checkout = provider.requests.find((r) => r.path === '/v1/checkout/sessions')!;
    assert.deepEqual([checkout.form['line_items[0][price]'], checkout.form['line_items[0][quantity]'], checkout.form['subscription_data[metadata][organisation_id]'],
      checkout.form['mode']], [PRICES.business, '10', org, 'subscription']);
    assert.ok(checkout.key?.startsWith(`checkout-${org}-`));

    const again = await gateway.call(startCheckout, { body: { plan: 'business', term: 'monthly', seats: 10 } }, { ...person(), idempotencyKey: key });
    assert.deepEqual(again, started);
    assert.equal(provider.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions').length, 1);
    assert.equal((await rows('select count(*)::int as n from billing.subscriptions where organisation_id = $1', [org]))[0]!.n, 0,
      'nothing is written until the webhook arrives');
  });

  test('a plan and term without a price cannot be bought; the permission is billing.manage', async () => {
    await refusedWith(gateway.call(startCheckout, { body: { plan: 'business', term: 'annual', seats: 10 } }, { ...person(), idempotencyKey: uuidv7() }),
      'billing.plan_unavailable');
    await refusedWith(gateway.call(startCheckout, { body: { plan: 'standard', term: 'monthly', seats: 3 } },
      { request: { organisationId: org, membershipId: member }, idempotencyKey: uuidv7() }), 'billing.not_permitted');
  });
});

describe('the payment webhook (spec 74.5, 75.3)', () => {
  test('a new subscription is mirrored and its entitlement written; billing status is unchanged', async () => {
    assert.deepEqual(await subscriptionChanges({}, 'customer.subscription.created'), { outcome: 'applied' });
    const [sub] = await rows('select plan, seat_count, term, discount_tier, status, stripe_customer_id from billing.subscriptions where organisation_id = $1', [org]);
    assert.deepEqual(sub, { plan: 'business', seat_count: 10, term: 'monthly', discount_tier: 'list', status: 'active', stripe_customer_id: 'cus_1' });
    const [entitlement] = await rows(
      `select seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit, capabilities, source
       from billing.entitlements where organisation_id = $1 and effective_to is null`, [org]);
    assert.deepEqual(entitlement, {
      seats: 10, tokens_per_seat_period: 1000, simulations_per_seat_period: 5, daily_token_limit: 40, capabilities: ['sso'], source: 'subscription',
    });
    assert.equal(await status(), 'active');
    assert.equal((await events('subscription_created')).length, 1);
    assert.equal((await events('billing_status_changed')).length, 0);
    // The seats bought arrive unassigned, billed from purchase (spec 72.2).
    const seats = await rows(`select status, plan_tier from billing.seats where organisation_id = $1`, [org]);
    assert.equal(seats.length, 10);
    assert.ok(seats.every((s) => s.status === 'unassigned' && s.plan_tier === 'business'));
    assert.equal((await events('seat_allocated')).length, 1);
  });

  test('an event delivered twice writes nothing more', async () => {
    const object = providerSubscription();
    const payload = JSON.stringify({ id: 'evt_dup', object: 'event', type: 'customer.subscription.updated', data: { object } });
    const signature = signPayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    await gateway.call(receivePaymentEvent, { body: { payload, signature } });
    await gateway.call(receivePaymentEvent, { body: { payload, signature } });
    assert.equal((await rows('select count(*)::int as n from billing.entitlements where organisation_id = $1', [org]))[0]!.n, 1);
    assert.equal((await events('subscription_created')).length, 1);
  });

  test('more seats version the entitlement: the old row closes as the new one opens', async () => {
    await subscriptionChanges({ quantity: 30 });
    const history = await rows(
      'select seats, effective_from, effective_to from billing.entitlements where organisation_id = $1 order by effective_from', [org]);
    assert.equal(history.length, 2);
    assert.equal(history[0]!.effective_to, history[1]!.effective_from, 'no gap, no overlap');
    assert.deepEqual([history[1]!.seats, history[1]!.effective_to], [30, null]);
    assert.equal((await rows('select discount_tier from billing.subscriptions where organisation_id = $1', [org]))[0]!.discount_tier, 'tier_25_99');
    assert.equal((await rows(`select count(*)::int as n from billing.seats where organisation_id = $1 and status <> 'released'`, [org]))[0]!.n, 30);
  });

  test('a plan change is recorded and changes the allowances in force', async () => {
    await subscriptionChanges({ quantity: 30, price: PRICES.standard });
    const [open] = await rows(
      `select tokens_per_seat_period as t, daily_token_limit as d, simulations_per_seat_period as s, capabilities as c
       from billing.entitlements where organisation_id = $1 and effective_to is null`, [org]);
    assert.deepEqual(open, { t: 300, d: 20, s: 0, c: [] });
    const [changed] = await events('plan_changed');
    assert.deepEqual((changed!['detail'] as Json)['from'], 'business');
    assert.deepEqual((changed!['detail'] as Json)['to'], 'standard');
  });

  test('payment state moves billing status, mirrored on the subscription, with the source event', async () => {
    await subscriptionChanges({ quantity: 30, price: PRICES.standard, status: 'past_due' });
    assert.equal(await status(), 'past_due');
    assert.equal((await rows('select status from billing.subscriptions where organisation_id = $1', [org]))[0]!.status, 'past_due');
    const [changed] = await events('billing_status_changed');
    assert.deepEqual(changed!['actor'], { kind: 'service', service: 'billing' });
    const detail = changed!['detail'] as Json;
    assert.deepEqual([detail['from'], detail['to'], detail['source']], ['active', 'past_due', 'payment_webhook']);
    assert.match(String(detail['provider_event_id']), /^evt_/);
    await subscriptionChanges({ quantity: 30, price: PRICES.standard, status: 'unpaid' });
    assert.equal(await status(), 'suspended');
    await subscriptionChanges({ quantity: 30, price: PRICES.standard, status: 'active' });
    assert.equal(await status(), 'active');
    assert.equal((await events('billing_status_changed')).length, 3);
  });

  test('a forged or stale signature is refused and changes nothing', async () => {
    const before = await rows('select count(*)::int as n from platform.outbox where organisation_id = $1', [org]);
    await refusedWith(deliver('customer.subscription.updated', providerSubscription({ status: 'canceled' }), { secret: 'whsec_not_the_secret' }),
      'payments.signature_invalid');
    await refusedWith(deliver('customer.subscription.updated', providerSubscription({ status: 'canceled' }),
      { signedAt: Math.floor(Date.now() / 1000) - 600 }), 'payments.signature_stale');
    await refusedWith(gateway.call(receivePaymentEvent, { body: { payload: '{"id":"evt_x"}', signature: 'v1=abc' } }), 'payments.signature_invalid');
    assert.equal(await status(), 'active');
    assert.deepEqual(await rows('select count(*)::int as n from platform.outbox where organisation_id = $1', [org]), before);
  });

  test('an event for another cell, an unknown organisation or an unpriced plan is acknowledged and ignored', async () => {
    // The tenant is read from the provider's current subscription, fetched afresh.
    assert.deepEqual(await subscriptionChanges({ cellId: 'eu-fra-1', status: 'canceled' }), { outcome: 'ignored' });
    assert.deepEqual(await subscriptionChanges({ organisationId: uuidv7(), status: 'canceled' }), { outcome: 'ignored' });
    assert.deepEqual(await subscriptionChanges({ price: 'price_unknown', status: 'canceled' }), { outcome: 'ignored' });
    assert.deepEqual(await deliver('charge.refunded', { id: 'ch_1' }), { outcome: 'ignored' });
    provider.subscriptions.set(SUBSCRIPTION, providerSubscription({ quantity: 30, price: PRICES.standard }));
    assert.equal(await status(), 'active');
    assert.equal((await rows('select status from billing.subscriptions where organisation_id = $1', [org]))[0]!.status, 'active');
  });

  test('no other role writes billing status (spec 75.3)', async () => {
    await assert.rejects(asOrg(() => app.query(`update iam.organisations set billing_status = 'active' where id = $1`, [org])), /permission denied/);
  });
});

describe('invoices (spec 74.5)', () => {
  const invoice = (status: string, paidAt?: number) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: 'in_sub_1', object: 'invoice', customer: 'cus_1', status, amount_due: 87_000, currency: 'gbp', created: now,
      collection_method: 'charge_automatically', metadata: {}, status_transitions: { paid_at: paidAt ?? null },
      lines: { data: [{ period: { start: Date.UTC(2026, 10, 1) / 1000, end: Date.UTC(2026, 11, 1) / 1000 } }] },
      parent: { subscription_details: { subscription: SUBSCRIPTION, metadata: { organisation_id: org, cell_id: CELL_ID } } },
    };
  };

  test('raised, then paid, each recorded once', async () => {
    await deliver('invoice.finalized', invoice('open'));
    let [row] = await rows('select amount::text, currency, status, period_covered, manual from billing.invoices where organisation_id = $1', [org]);
    assert.deepEqual(row, { amount: '870.00', currency: 'GBP', status: 'open', period_covered: '2026-11', manual: false });
    await deliver('invoice.paid', invoice('paid', Math.floor(Date.now() / 1000)));
    await deliver('invoice.paid', invoice('paid', Math.floor(Date.now() / 1000)));
    [row] = await rows('select status, paid_at is not null as paid from billing.invoices where organisation_id = $1', [org]);
    assert.deepEqual(row, { status: 'paid', paid: true });
    assert.equal((await events('invoice_raised')).length, 1);
    assert.equal((await events('invoice_paid')).length, 1);
  });

  test('the billing page shows status, plan, entitlement and invoices under billing.view', async () => {
    const page = await gateway.call(readBilling, {}, person());
    assert.equal(page.billingStatus, 'active');
    assert.deepEqual([page.subscription?.plan, page.subscription?.seatCount], ['standard', 30]);
    assert.equal(page.entitlement?.tokensPerSeatPeriod, 300);
    assert.deepEqual(page.invoices.map((i) => [i.amount, i.status]), [['870.00', 'paid']]);
    const portalSession = await gateway.call(openBillingPortal, {}, person());
    assert.match(portalSession.portalUrl, /^https:\/\/portal\.example\//);
    await refusedWith(gateway.call(readBilling, {}, { request: { organisationId: org, membershipId: member } }), 'billing.not_permitted');
  });
});

describe('purchases (spec 73.4, 73.8)', () => {
  const balance = async (membershipId: string): Promise<number> =>
    (await rows('select purchased_remaining as p from billing.token_balances where membership_id = $1', [membershipId]))[0]?.p ?? 0;

  test('£20 per 100 tokens, paid once, then credited by metering', async () => {
    const key = uuidv7();
    const bought = await gateway.call(purchase, { body: { kind: 'tokens', quantity: 200 } }, { ...person(), idempotencyKey: key });
    assert.deepEqual([bought.amount, bought.currency, bought.quantity], ['40.00', 'GBP', 200]);
    const item = provider.requests.find((r) => r.path === '/v1/invoiceitems')!;
    assert.deepEqual([item.form['amount'], item.form['currency'], item.key], ['4000', 'gbp', `purchase-${bought.purchaseId}:item`]);
    assert.equal(await balance(root.membershipId), 200);
    const [row] = await rows('select kind, quantity, amount::text, stripe_invoice_id from billing.purchases where id = $1', [bought.purchaseId]);
    assert.deepEqual([row!.kind, row!.quantity, row!.amount], ['tokens', 200, '40.00']);
    assert.match(row!.stripe_invoice_id, /^in_/);

    const pays = provider.requests.filter((r) => r.path.endsWith('/pay')).length;
    const again = await gateway.call(purchase, { body: { kind: 'tokens', quantity: 200 } }, { ...person(), idempotencyKey: key });
    assert.deepEqual(again, bought);
    assert.equal(provider.requests.filter((r) => r.path.endsWith('/pay')).length, pays, 'a retry takes no second payment');
    assert.equal(await balance(root.membershipId), 200);
  });

  test('for another member, as the beneficiary', async () => {
    await gateway.call(purchase, { body: { kind: 'tokens', quantity: 100, beneficiaryMembershipId: member } }, { ...person(), idempotencyKey: uuidv7() });
    assert.equal(await balance(member), 100);
  });

  test('a declined card credits nothing and leaves no invoice to collect later', async () => {
    provider.decline = true;
    try {
      await refusedWith(gateway.call(purchase, { body: { kind: 'tokens', quantity: 100 } }, { ...person(), idempotencyKey: uuidv7() }),
        'billing.payment_declined');
    } finally {
      provider.decline = false;
    }
    assert.equal(await balance(root.membershipId), 200);
    assert.ok(provider.requests.some((r) => r.path.endsWith('/void')));
  });

  test('tokens come in hundreds; simulation top-ups wait for a price', async () => {
    await refusedWith(gateway.call(purchase, { body: { kind: 'tokens', quantity: 150 } }, { ...person(), idempotencyKey: uuidv7() }),
      'billing.tokens_in_hundreds');
    await refusedWith(gateway.call(purchase, { body: { kind: 'simulations', quantity: 2 } }, { ...person(), idempotencyKey: uuidv7() }),
      'billing.simulation_price_unset');
  });
});

describe('seat counts at the provider (spec 72.2, 74.5)', () => {
  const seatCount = async (): Promise<number> =>
    Number((await rows(`select seat_count from billing.subscriptions where organisation_id = $1 and status <> 'cancelled'`, [org]))[0]!.seat_count);
  const liveSeats = async (): Promise<number> =>
    Number((await rows(`select count(*)::int as n from billing.seats where status <> 'released' and subscription_id is not null`))[0]!.n);
  const lastUpdate = () => provider.requests.filter((r) => r.method === 'POST' && r.path === `/v1/subscriptions/${SUBSCRIPTION}`).at(-1)!;
  const spareSeat = async (): Promise<string> =>
    (await rows(`select id from billing.seats where status = 'unassigned' and subscription_id is not null order by created_at, id limit 1`))[0]!.id;

  test('buying seats raises the provider\'s count, prorated and invoiced now; the seats arrive at once, unassigned', async () => {
    const before = await seatCount();
    const out = await gateway.call(buySeats, { body: { seats: 2 } }, { ...person(), idempotencyKey: uuidv7() });
    assert.deepEqual(out, { seatCount: before + 2, added: 2 });
    assert.deepEqual([lastUpdate().form['items[0][quantity]'], lastUpdate().form['proration_behavior']], [String(before + 2), 'always_invoice']);
    assert.deepEqual([await seatCount(), await liveSeats()], [before + 2, before + 2]);
    assert.equal((await events('seat_allocated')).at(-1)!['detail'] && ((await events('seat_allocated')).at(-1)!['detail'] as Json)['seats'], 2);
  });

  test('releasing a seat lowers the provider\'s count with no proration: nothing refunded, the next invoice bills fewer', async () => {
    const count = await seatCount();
    await gateway.call(releaseSeat, { params: { seatId: await spareSeat() } }, person());
    assert.deepEqual([lastUpdate().form['items[0][quantity]'], lastUpdate().form['proration_behavior']], [String(count - 1), 'none']);
    assert.deepEqual([await seatCount(), await liveSeats()], [count - 1, count - 1], 'and the released seat is not created again');
  });

  test('a release the provider was not told of is drift, which the next release (or the sweep) corrects', async () => {
    await migrate.query(`update billing.seats set status = 'released', released_at = now() where id = $1`, [await spareSeat()]);
    const drifted = async () => (await migrate.query('select organisation_id from billing.subscriptions_seat_drift(10)')).rows.some((r) => r.organisation_id === org);
    assert.equal(await drifted(), true);
    await gateway.call(releaseSeat, { params: { seatId: await spareSeat() } }, person());
    assert.equal(await drifted(), false);
    assert.equal(await seatCount(), await liveSeats());
  });

  test('500 seats and above are quoted', async () => {
    await refusedWith(gateway.call(buySeats, { body: { seats: 498 } }, { ...person(), idempotencyKey: uuidv7() }), 'billing.seats_quoted');
  });
});

describe('auto top-up (spec 73.4)', () => {
  let topup: string;
  const chargeAs = (membershipId: string) => compile.call(charge, { body: { operation: 'compile', correlationId: uuidv7() } },
    { request: { organisationId: org, membershipId }, idempotencyKey: uuidv7() });

  before(async () => {
    topup = await createMembership(app, org, await createUser(auth, 'topup@acme.example'));
  });

  test('off by default: exhaustion refuses, saying what was exhausted and how to continue, and buys nothing', async () => {
    const details = await refusedWith(chargeAs(topup), 'metering.no_allowance');
    assert.equal(details['autoTopup'], undefined);
    assert.equal((await rows('select count(*)::int as n from billing.purchases where beneficiary_membership_id = $1', [topup]))[0]!.n, 0);
  });

  test('switched on under tokens.purchase, audited; a refused charge then buys 100 tokens on the card and goes ahead', async () => {
    assert.deepEqual(await gateway.call(setAutoTopup, { params: { membershipId: topup }, body: { enabled: true } }, person()),
      { membershipId: topup, autoTopup: true });
    assert.equal((await gateway.call(readAllowance, { params: { membershipId: topup } }, person())).balance.autoTopup, true, 'read back with the allowance');
    const toggled = (await events('auto_topup_toggled')).at(-1)!;
    assert.deepEqual([toggled['subjectMembershipId'], (toggled['detail'] as Json)['enabled']], [topup, true]);
    const charged = await chargeAs(topup);
    assert.ok(charged.charged && charged.source === 'purchase', JSON.stringify(charged));
    const [bought] = await rows('select quantity, amount::text as amount, auto_topup from billing.purchases where beneficiary_membership_id = $1', [topup]);
    assert.deepEqual([bought!.quantity, bought!.amount, bought!.auto_topup], [100, '20.00', true]);
    const [balance] = await rows('select purchased_remaining, onboarding_granted_at from billing.token_balances where membership_id = $1', [topup]);
    assert.deepEqual([balance!.purchased_remaining, balance!.onboarding_granted_at], [99, null], 'the onboarding grant is still to come with a seat');
  });

  test('bounded per day: past the day\'s limit the refusal stands, and says why', async () => {
    await migrate.query('update billing.token_balances set purchased_remaining = 0 where membership_id = $1', [topup]);
    const details = await refusedWith(chargeAs(topup), 'metering.no_allowance');
    assert.deepEqual([details['autoTopup'], details['autoTopupCode']], ['failed', 'billing.auto_topup_limit']);
  });

  test('a declined card buys nothing, and the refusal says so', async () => {
    const other = await createMembership(app, org, await createUser(auth, 'declined@acme.example'));
    await gateway.call(setAutoTopup, { params: { membershipId: other }, body: { enabled: true } }, person());
    provider.decline = true;
    try {
      const details = await refusedWith(chargeAs(other), 'metering.no_allowance');
      assert.deepEqual([details['autoTopup'], details['autoTopupCode']], ['failed', 'billing.payment_declined']);
      assert.equal((await rows('select count(*)::int as n from billing.purchases where beneficiary_membership_id = $1', [other]))[0]!.n, 0);
    } finally {
      provider.decline = false;
    }
  });
});

describe('staff paths (spec 75.3)', () => {
  let operator: string;
  let session: string;

  before(async () => {
    operator = uuidv7();
    const approver = uuidv7();
    session = uuidv7();
    for (const [id, subject] of [[operator, 'staff-1'], [approver, 'staff-2']] as const) {
      await migrate.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident) values ($1, $2, $2, 'sc', true)`,
        [id, `${subject}-${randomBytes(3).toString('hex')}`]);
    }
    await migrate.query(
      `insert into platform.operator_access_sessions (id, organisation_id, operator_id, operator_display_name, purpose, access_level, reason,
         ticket_reference, requested_minutes, status, customer_approval_required, staff_approver_operator_id, staff_approver_display_name,
         staff_approved_at, starts_at, expires_at)
       values ($1, $2, $3, 'Staff One', 'support_request', 'tenant_act', 'billing correction', 'T-1', 60, 'active', false, $4, 'Staff Two',
         now(), now(), now() + interval '1 hour')`,
      [session, org, operator, approver]);
  });

  const staff = () => ({ request: { organisationId: org, operatorSessionId: session } });

  test('a named staff identity and a reason move billing status, with the same event', async () => {
    const result = await portal.call(setBillingStatus, { body: { status: 'suspended', reason: 'invoice unpaid after 60 days' } }, staff());
    assert.deepEqual(result, { billingStatus: 'suspended', changed: true });
    assert.equal(await status(), 'suspended');
    assert.equal((await rows('select status from billing.subscriptions where organisation_id = $1', [org]))[0]!.status, 'suspended');
    const changed = (await events('billing_status_changed')).at(-1)!;
    assert.deepEqual(changed['actor'], { kind: 'operator', operatorId: operator, operatorAccessSessionId: session });
    assert.equal(changed['operatorAccessSessionId'], session);
    assert.deepEqual([(changed['detail'] as Json)['source'], (changed['detail'] as Json)['reason']], ['staff', 'invoice unpaid after 60 days']);
    assert.deepEqual(await portal.call(setBillingStatus, { body: { status: 'suspended', reason: 'again' } }, staff()),
      { billingStatus: 'suspended', changed: false });
  });

  test('never without an operator session, and never from a tenant endpoint', async () => {
    await refusedWith(portal.call(setBillingStatus, { body: { status: 'active', reason: 'lift it' } }, { request: { organisationId: org } }),
      'billing.operator_session_required');
    // The contract lists the admin portal only, so the gateway (every tenant endpoint) is refused.
    await refusedWith(gateway.call(setBillingStatus as never, { body: { status: 'active', reason: 'lift it' } } as never, person() as never),
      'caller.not_listed');
    assert.equal(await status(), 'suspended');
  });
});
