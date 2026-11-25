// The metering service (spec 72.5, 73, 74.1): the consumption rules on their own, then the
// service end to end as a real process on a fresh cell database, with credential, auth
// and policy for billing.view, and the local JetStream for metering.usage.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { login } from '../../src/contracts/auth/session.contract.ts';
import { grantAllowance, readAllowance } from '../../src/contracts/metering/allowance.contract.ts';
import { charge } from '../../src/contracts/metering/charge.contract.ts';
import { engagementCost, listLedger } from '../../src/contracts/metering/ledger.contract.ts';
import { creditPurchase } from '../../src/contracts/metering/purchase.contract.ts';
import { storageMeasuredMessage } from '../../src/contracts/metering/usage.contract.ts';
import { modelUsageMessage } from '../../src/contracts/model-gateway/events.contract.ts';
import { envelopeOf, type OutboxMessage } from '../../src/contracts/outbox-relay/catalogue.contract.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { connectDurableBus, type DurableBus, type DurableMessage } from '../../src/infra/bus.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createMeteringService } from '../../src/routes/metering/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import {
  chooseSimulationSource, chooseTokenSource, fromUnits, prorate, remainingFraction, toUnits, weightOf,
} from '../../src/services/metering/funds.service.ts';
import { isAppError } from '../../src/utils/errors.util.ts';
import { CELL_ID, createLocalCell, createMembership, createUser } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';

describe('the consumption rules (spec 73.1, 73.4, 73.7)', () => {
  const funds = (grant: number, remaining: number | undefined, dailyRemaining: number, purchased: number) =>
    ({ grant, allowance: remaining === undefined ? undefined : { remaining, dailyRemaining }, purchased });

  test('weights are fixed per operation; a re-run charges the reduced rate', () => {
    const settings = { rephraseWindowSeconds: 600, simulationRerunWeight: '0.5' };
    assert.deepEqual(
      (['compile', 'advanced_compile', 'repair_proposal', 'connector_generation', 'document_extraction', 'simulation', 'simulation_rerun'] as const)
        .map((op) => weightOf(op, settings)),
      ['1', '3', '2', '6', '6', '1', '0.5']);
  });

  test('grant, then allowance within the day, then purchased; the first that covers the whole weight pays', () => {
    assert.deepEqual(chooseTokenSource(funds(200, 1000, 40, 0), 3), { source: 'grant' });
    assert.deepEqual(chooseTokenSource(funds(2, 1000, 40, 0), 3), { source: 'allowance' }, 'never split across sources');
    assert.deepEqual(chooseTokenSource(funds(0, 1000, 2, 50), 3), { source: 'purchase' }, 'purchased tokens raise the daily ceiling');
    assert.deepEqual(chooseTokenSource(funds(0, 1000, 2, 0), 3), { refused: 'daily_limit_reached' });
    assert.deepEqual(chooseTokenSource(funds(0, 2, 40, 0), 3), { refused: 'allowance_exhausted' });
    assert.deepEqual(chooseTokenSource(funds(0, undefined, 0, 0), 1), { refused: 'no_allowance' });
    assert.deepEqual(chooseTokenSource(funds(0, undefined, 0, 6), 6), { source: 'purchase' });
  });

  test('simulations never touch the token pool, and count in fractions', () => {
    assert.deepEqual(chooseSimulationSource({ allowanceRemaining: toUnits('0.5'), purchased: 0n }, toUnits('0.5')), { source: 'allowance' });
    assert.deepEqual(chooseSimulationSource({ allowanceRemaining: toUnits('0.25'), purchased: toUnits('3') }, toUnits('1')), { source: 'purchase' });
    assert.deepEqual(chooseSimulationSource({ allowanceRemaining: 0n, purchased: 0n }, toUnits('1')), { refused: 'allowance_exhausted' });
    assert.equal(fromUnits(toUnits('4.5000') - toUnits('0.5')), '4');
    assert.equal(fromUnits(toUnits('0.1') + toUnits('0.2')), '0.3');
  });

  test('a mid-period seat is prorated to the rest of the period, rounded up', () => {
    const period = { periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z' };
    assert.equal(remainingFraction(period, '2026-11-16T00:00:00.000Z'), 0.5);
    assert.equal(prorate(1000, 0.5), 500);
    assert.equal(prorate(1000, remainingFraction(period, period.periodStart)), 1000);
    assert.equal(prorate(5, 0.01), 1);
    assert.equal(prorate(300, 0), 0);
  });
});

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
const processes: RunningProcess[] = [];
let gateway: ServiceClient;
let compile: ServiceClient;
let authCaller: ServiceClient;
let billingCaller: ServiceClient;
let fde: ServiceClient;
let bus: DurableBus;
const consumer = `metering-t${randomBytes(4).toString('hex')}`;
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

let org: string;
let root: { membershipId: string; sessionId: string };
let member: string;
let unseated: string;
let subscription: string;

const env = (service: string, login: 'test_auth' | 'test_credential' | 'test_app', extra: Record<string, string> = {}): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', PG_CONTROL_URL: h.url(login),
  REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, ...extra,
});

const asOrg = <T>(work: () => Promise<T>): Promise<T> => inTx(app, { orgId: org }, work);
const one = async (sql: string, params: unknown[] = []) => (await asOrg(() => app.query(sql, params))).rows[0];
const ledgerCount = async (): Promise<number> =>
  (await one('select count(*)::int as n from billing.token_transactions where organisation_id = $1', [org])).n;
const events = async (name: string): Promise<Record<string, unknown>[]> => (await asOrg(() => app.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by id`,
  [org, name]))).rows.map((r) => r.payload);

const as = (membershipId: string) => ({ request: { organisationId: org, membershipId } });
const compileCharge = (membershipId: string, operation: 'compile' | 'advanced_compile', extra: Record<string, unknown> = {}, key = uuidv7()) =>
  compile.call(charge, { body: { operation, correlationId: uuidv7(), ...extra } }, { ...as(membershipId), idempotencyKey: key });

async function refusedWith(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isAppError(error), 'an AppError');
    assert.equal(error.code, code);
    return { ...error.details, message: error.message, category: error.category };
  }
  throw new assert.AssertionError({ message: `expected ${code}` });
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
  unseated = await createMembership(app, org, await createUser(auth, 'unseated@acme.example'));

  // What billing writes from a verified subscription: the mirror, the entitlement (Business,
  // spec 71.2) and seats, two of them assigned.
  subscription = uuidv7();
  await asOrg(async () => {
    await app.query(
      `insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id,
         stripe_subscription_id, current_period_start, current_period_end, status)
       values ($1, $2, 'business', 10, 'monthly', 'list', 'cus_t', $3, now() - interval '1 day', now() + interval '29 days', 'active')`,
      [subscription, org, `sub_${randomBytes(6).toString('hex')}`]);
    await app.query(
      `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period,
         daily_token_limit, storage_included_bytes, capabilities, source, subscription_id, effective_from)
       values ($1, $2, 10, 1000, 5, 40, 0, '{sso}', 'subscription', $3, now())`, [uuidv7(), org, subscription]);
    for (const m of [created.membershipId, member]) {
      await app.query(
        `insert into billing.seats (id, organisation_id, subscription_id, membership_id, plan_tier, status)
         values ($1, $2, $3, $4, 'business', 'assigned')`, [uuidv7(), org, subscription, m]);
    }
  });

  const credential = await runProcess([credentialService], env('credential', 'test_credential', {
    KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', 'test_app'), { logger: quiet });
  const authConfig = env('auth', 'test_auth', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ARGON2_MEMORY_KIB: '1024',
    ARGON2_PASSES: '1', SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  });
  const authProcess = await runProcess([createAuthService()], authConfig, { logger: quiet });
  const meteringConfig = env('metering', 'test_app', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl,
    SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  });
  const metering = await runProcess([createMeteringService({ consumer, settings: { rephraseWindowSeconds: 60 } })], meteringConfig, { logger: quiet });
  processes.push(metering, authProcess, policy, credential);

  const urls = { auth: `http://127.0.0.1:${authProcess.port}`, metering: `http://127.0.0.1:${metering.port}` };
  const client = (caller: 'gateway' | 'compile' | 'auth' | 'billing' | 'fde-orchestrator') =>
    createServiceClient({ caller, http: { ...meteringConfig.http, serviceUrls: urls } });
  gateway = client('gateway');
  compile = client('compile');
  authCaller = client('auth');
  billingCaller = client('billing');
  fde = client('fde-orchestrator');
  bus = await connectDurableBus(meteringConfig.bus, 'test');

  const signed = await gateway.call(login, { body: { organisationSlug: 'acme', email: 'root@acme.example', password: PASSWORD } });
  root = { membershipId: signed.membershipId, sessionId: signed.sessionId };
});

after(async () => {
  for (const c of [gateway, compile, authCaller, billingCaller, fde]) c?.close();
  await bus?.close();
  for (const p of processes) await p.stop('test');
  // The durable consumer this run created.
  const nc = await connect({ servers: LOCAL.natsUrl }).catch(() => undefined);
  if (nc) {
    await (await jetstreamManager(nc)).consumers.delete('SILO_DURABLE', `${consumer}-metering-usage`).catch(() => undefined);
    await nc.close();
  }
  await h?.close();
});

describe('allowances (spec 72.5, 73.3, 73.4)', () => {
  test('granted on seat assignment, prorated, with the onboarding grant once; repeating changes nothing', async () => {
    const first = await authCaller.call(grantAllowance, { body: { membershipId: root.membershipId } }, as(root.membershipId));
    assert.equal(first.granted, true);
    assert.equal(first.onboardingGranted, true);
    assert.ok(first.tokens.granted > 0 && first.tokens.granted <= 1000, 'prorated to the rest of the period');
    assert.equal(first.tokens.dailyLimit, 40);
    assert.ok(first.simulations.granted <= 5);
    const again = await authCaller.call(grantAllowance, { body: { membershipId: root.membershipId } }, as(root.membershipId));
    assert.equal(again.granted, false);
    assert.equal(again.onboardingGranted, false);
    assert.deepEqual(again.tokens, first.tokens);
    assert.equal((await events('allowance_granted')).length, 1);
    const balance = await one('select onboarding_grant_remaining as g from billing.token_balances where membership_id = $1', [root.membershipId]);
    assert.equal(balance.g, 200);
  });

  test('never for a membership without a seat', async () => {
    await refusedWith(authCaller.call(grantAllowance, { body: { membershipId: unseated } }, as(root.membershipId)), 'metering.no_seat');
  });

  test('a person reads their own; another member\'s needs billing.view, which policy decides', async () => {
    const own = await gateway.call(readAllowance, { params: { membershipId: root.membershipId } },
      { request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });
    assert.deepEqual([own.balance.onboardingGrantRemaining, own.balance.autoTopup], [200, false]);
    const other = await gateway.call(readAllowance, { params: { membershipId: member } },
      { request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });
    assert.equal(other.tokens, null, 'no allowance yet this period');
    await refusedWith(gateway.call(readAllowance, { params: { membershipId: root.membershipId } },
      { request: { organisationId: org, membershipId: member } }), 'metering.not_permitted');
  });
});

describe('charges (spec 73.1 to 73.6)', () => {
  test('consumption order: grant, then allowance, and every charge is one ledger row', async () => {
    await asOrg(() => app.query('update billing.token_balances set onboarding_grant_remaining = 2 where membership_id = $1', [root.membershipId]));
    const a = await compileCharge(root.membershipId, 'compile');
    assert.ok(a.charged);
    assert.equal(a.source, 'grant');
    const b = await compileCharge(root.membershipId, 'advanced_compile');
    assert.ok(b.charged);
    assert.deepEqual([b.source, b.weight], ['allowance', '3'], '1 grant token left cannot pay 3');
    const c = await compileCharge(root.membershipId, 'compile');
    assert.ok(c.charged && c.source === 'grant');
    const allowance = await one('select tokens_consumed as used, daily_consumed as today from billing.token_allowances where membership_id = $1',
      [root.membershipId]);
    assert.deepEqual([allowance.used, allowance.today], [3, 3]);
    assert.equal(await ledgerCount(), 3);
  });

  test('a retry under the same Idempotency-Key returns the first charge and charges nothing more', async () => {
    const key = uuidv7();
    const correlationId = uuidv7();
    const first = await compile.call(charge, { body: { operation: 'compile', correlationId } }, { ...as(root.membershipId), idempotencyKey: key });
    const count = await ledgerCount();
    const again = await compile.call(charge, { body: { operation: 'compile', correlationId } }, { ...as(root.membershipId), idempotencyKey: key });
    assert.deepEqual(again, first);
    assert.equal(await ledgerCount(), count);
  });

  test('never metered: a cache hit, a saved view, a cron run write no row', async () => {
    const count = await ledgerCount();
    for (const trigger of ['cache_hit', 'saved_view_run', 'cron_run', 'refusal'] as const) {
      assert.deepEqual(await compileCharge(root.membershipId, 'compile', { trigger }), { charged: false, reason: 'never_metered' });
    }
    assert.equal(await ledgerCount(), count);
  });

  test('a rephrase within the window charges once, and only for the same member', async () => {
    const first = await compile.call(charge, { body: { operation: 'compile', correlationId: uuidv7() } },
      { ...as(root.membershipId), idempotencyKey: uuidv7() });
    assert.ok(first.charged);
    const priorId = (await one('select correlation_id as c from billing.token_transactions where id = $1', [first.transactionId])).c as string;
    const count = await ledgerCount();
    assert.deepEqual(await compileCharge(root.membershipId, 'compile', { rephraseOf: priorId }), { charged: false, reason: 'rephrase_window' });
    assert.equal(await ledgerCount(), count);
    const other = await compileCharge(member, 'compile', { rephraseOf: priorId });
    assert.ok(other.charged, "another member's rephrase is their own compile");
    const unknown = await compileCharge(root.membershipId, 'compile', { rephraseOf: uuidv7() });
    assert.ok(unknown.charged, 'outside the window it is a new compile');
  });

  test('a seat held into a period gets its full allowance on the first charge there', async () => {
    const result = await compileCharge(member, 'compile');
    assert.ok(result.charged);
    const row = await one('select tokens_granted as g from billing.token_allowances where membership_id = $1', [member]);
    assert.equal(row.g, 1000);
  });

  test('the daily limit refuses with the bound named, writes nothing, and raises daily_limit_reached once', async () => {
    await asOrg(() => app.query(
      `update billing.token_allowances set daily_consumed = 39, daily_consumed_on = (now() at time zone 'Europe/London')::date
       where membership_id = $1`, [root.membershipId]));
    const count = await ledgerCount();
    const details = await refusedWith(compileCharge(root.membershipId, 'advanced_compile'), 'metering.daily_limit_reached');
    assert.deepEqual([details['category'], details['bound'], details['limit']], ['bounds', 'daily_token_limit', 40]);
    assert.match(String(details['message']), /resets tomorrow; buy tokens to continue today/);
    await refusedWith(compileCharge(root.membershipId, 'advanced_compile'), 'metering.daily_limit_reached');
    assert.equal(await ledgerCount(), count, 'a refusal never writes a charging row');
    assert.equal((await events('daily_limit_reached')).length, 1, 'one notice per member and day');
    const fits = await compileCharge(root.membershipId, 'compile');
    assert.ok(fits.charged && fits.source === 'allowance', 'a charge that fits the day still passes');
  });

  test('purchased tokens are credited once, and raise the daily ceiling', async () => {
    const purchaseId = uuidv7();
    const body = {
      purchaseId, kind: 'tokens' as const, quantity: 100, amount: '20.00', purchasedBy: root.membershipId, beneficiaryMembershipId: root.membershipId,
    };
    const first = await billingCaller.call(creditPurchase, { body }, as(root.membershipId));
    assert.deepEqual([first.credited, first.balance.purchasedRemaining], [true, 100]);
    const again = await billingCaller.call(creditPurchase, { body }, as(root.membershipId));
    assert.deepEqual([again.credited, again.balance.purchasedRemaining], [false, 100]);
    const paid = await compileCharge(root.membershipId, 'advanced_compile');
    assert.ok(paid.charged);
    assert.equal(paid.source, 'purchase');
    assert.equal((await events('tokens_purchased')).length, 1);
  });

  test('an exhausted allowance with nothing purchased refuses, saying what ran out and how to continue', async () => {
    await asOrg(() => app.query(
      `update billing.token_allowances set tokens_consumed = tokens_granted, daily_consumed = 0 where membership_id = $1`, [member]));
    const details = await refusedWith(compileCharge(member, 'compile'), 'metering.allowance_exhausted');
    assert.equal(details['bound'], 'token_allowance');
    assert.match(String(details['message']), /allowance of 1000 tokens is used and no purchased tokens remain\. Buy tokens/);
    assert.equal((await events('allowance_exhausted')).length, 1);
  });

  test('no seat, no allowance: refused, unless the member bought tokens', async () => {
    await refusedWith(compileCharge(unseated, 'compile'), 'metering.no_allowance');
    await billingCaller.call(creditPurchase, { body: {
      purchaseId: uuidv7(), kind: 'tokens', quantity: 100, amount: '20.00', purchasedBy: root.membershipId, beneficiaryMembershipId: unseated,
    } }, as(root.membershipId));
    const paid = await compileCharge(unseated, 'compile');
    assert.ok(paid.charged && paid.source === 'purchase');
  });

  test('simulations draw their own allowance, and a re-run charges a fraction', async () => {
    // The run the charge pays for (the ledger keys it). Its metering_transaction_id cannot
    // name the ledger row: see the schema note in the report.
    const runs = [uuidv7()];
    const scenario = uuidv7();
    await asOrg(async () => {
      await app.query(
        `insert into simulation.scenarios (id, organisation_id, owner_membership_id, name, kind, mode, bounds, graph_version)
         values ($1, $2, $3, 'Supplier fails', 'branch', 'deterministic', '{}', 1)`, [scenario, org, member]);
      await app.query(
        `insert into simulation.simulation_runs (id, organisation_id, scenario_id, run_by_membership_id, mode, graph_version, started_at)
         values ($1, $2, $3, $4, 'deterministic', 1, now())`, [runs[0], org, scenario, member]);
    });
    const sim = await compile.call(charge, { body: { operation: 'simulation', correlationId: runs[0]!, simulationRunId: runs[0]! } },
      { ...as(member), idempotencyKey: uuidv7() });
    assert.ok(sim.charged);
    assert.deepEqual([sim.pool, sim.source, sim.weight], ['simulations', 'allowance', '1']);
    const rerun = await compile.call(charge, { body: { operation: 'simulation_rerun', correlationId: runs[0]!, simulationRunId: runs[0]! } },
      { ...as(member), idempotencyKey: uuidv7() });
    assert.ok(rerun.charged && rerun.weight === '0.5');
    const row = await one('select simulations_consumed::text as used from billing.simulation_allowances where membership_id = $1', [member]);
    assert.equal(row.used, '1.5000');
  });

  test('each operation names what it paid for', async () => {
    await refusedWith(compile.call(charge, { body: { operation: 'document_extraction', correlationId: uuidv7() } },
      { ...as(member), idempotencyKey: uuidv7() }), 'contract.request_invalid');
  });
});

describe('AI FDE metering (spec 73.5, 52.6)', () => {
  let engagement: string;
  const principal = uuidv7();
  const fdeCharge = (operation: 'compile' | 'advanced_compile') =>
    fde.call(charge, { body: { operation, correlationId: uuidv7(), engagementId: engagement } },
      { request: { organisationId: org, servicePrincipalId: principal }, idempotencyKey: uuidv7() });

  before(async () => {
    engagement = uuidv7();
    await asOrg(() => app.query(
      `insert into fde.fde_engagements (id, organisation_id, name, goals, engaging_membership_id, engagement_class, cell_id, token_budget,
         provider_cost_budget, rate_limits, model_route, started_at)
       values ($1, $2, 'Onboarding', 'Connect the ERP', $3, 'standard', $4, 10, 100, $5, 'default', now())`,
      [engagement, org, root.membershipId, CELL_ID, JSON.stringify({
        model_calls_per_minute: 10, probes_per_minute: 10, proposals_per_hour: 10, concurrent_tasks: 1, pending_proposals_per_decider: 5,
        attempts_per_task: 3,
      })]));
  });

  test('without a contract, from the engaging member\'s purchased balance only, within the token budget', async () => {
    const before = await one('select purchased_remaining as p, onboarding_grant_remaining as g from billing.token_balances where membership_id = $1',
      [root.membershipId]);
    const a = await fdeCharge('advanced_compile');
    assert.ok(a.charged);
    assert.equal(a.source, 'purchase');
    const after = await one('select purchased_remaining as p, onboarding_grant_remaining as g from billing.token_balances where membership_id = $1',
      [root.membershipId]);
    assert.deepEqual([before.p - after.p, before.g - after.g], [3, 0], 'never the grant or an allowance');
    await fdeCharge('advanced_compile');
    await fdeCharge('advanced_compile');
    const count = await ledgerCount();
    const details = await refusedWith(fdeCharge('advanced_compile'), 'metering.engagement_budget');
    assert.deepEqual([details['bound'], details['limit']], ['engagement_token_budget', 10]);
    assert.equal(await ledgerCount(), count);
    const used = await one('select tokens_consumed::int as n from fde.fde_engagements where id = $1', [engagement]);
    assert.equal(used.n, 9, 'the running total, within the budget');
    const rows = await asOrg(() => app.query('select membership_id, source from billing.token_transactions where engagement_id = $1', [engagement]));
    assert.ok(rows.rows.every((r) => r.membership_id === root.membershipId && r.source === 'purchase'));
  });

  test('the engagement cost report sums what was charged, by operation', async () => {
    const report = await gateway.call(engagementCost, { params: { engagementId: engagement } },
      { request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });
    const used = await one('select tokens_consumed::text as n from fde.fde_engagements where id = $1', [engagement]);
    assert.equal(report.tokensCharged, used.n);
    assert.ok(report.lines.some((l) => l.operation === 'advanced_compile' && l.source === 'purchase'));
  });

  test('and the underlying model cost where measured: priced calls summed, an unpriced one counted (73.5, D106)', async () => {
    for (const cost of ['0.01250000', '0.00750000', null]) {
      await migrate.query(
        `insert into platform.model_calls (organisation_id, call_id, correlation_id, engagement_id, caller_service, request_type, model, model_route,
           input_tokens, output_tokens, prompt_hash, outcome, provider_cost)
         values ($1, $2, $3, $4, 'fde-orchestrator', 'vocabulary', 'm', 'fde', 100, 10, $5, 'ok', $6)`,
        [org, uuidv7(), uuidv7(), engagement, Buffer.alloc(32, 1), cost]);
    }
    const report = await gateway.call(engagementCost, { params: { engagementId: engagement } },
      { request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } });
    assert.deepEqual(report.modelCost, { calls: 3, priced: 2, amount: '0.02000000', measured: false });
  });
});

describe('the ledger (spec 73.6)', () => {
  test('under billing.view, newest first, paged', async () => {
    const context = { request: { organisationId: org, membershipId: root.membershipId, sessionId: root.sessionId } };
    const first = await gateway.call(listLedger, { query: { limit: 3 } }, context);
    assert.equal(first.transactions.length, 3);
    assert.ok(first.next);
    const second = await gateway.call(listLedger, { query: { limit: 3, ...first.next } }, context);
    assert.ok(second.transactions.every((t) => t.occurredAt <= first.transactions.at(-1)!.occurredAt));
    assert.ok(!second.transactions.some((t) => first.transactions.some((f) => f.id === t.id)));
    const total = await ledgerCount();
    const all = await gateway.call(listLedger, { query: { limit: 200 } }, context);
    assert.equal(all.transactions.length, total);
    await refusedWith(gateway.call(listLedger, { query: {} }, { request: { organisationId: org, membershipId: member } }), 'metering.not_permitted');
  });
});

// As the outbox relay publishes: the payload in its envelope, the outbox row id as the event id.
const asRelayed = (message: OutboxMessage): DurableMessage =>
  ({ bus: 'durable', topic: message.topic, name: message.name, version: message.version, schema: envelopeOf(message.schema) }) as DurableMessage;
const relay = (message: OutboxMessage, payload: unknown) => bus.publish(asRelayed(message),
  { organisationId: org, occurredAt: new Date().toISOString(), correlationId: uuidv7(), payload } as never, { eventId: uuidv7(), orderingKey: org });

describe('Siloes byte counts from metering.usage (spec 74.1)', () => {
  test('each measurement is recorded once; one that can never be recorded is dropped, not redelivered for ever', async () => {
    const silo = uuidv7();
    await asOrg(() => app.query(
      `insert into siloes.siloes (id, organisation_id, kind, name, purpose, retention_days, location, created_by)
       values ($1, $2, 'capture', 'Orders', 'History of orders', 365, 'europe-west2', $3)`, [silo, org, root.membershipId]));
    const measurement = (siloId: string) => ({
      organisationId: org, measurementId: uuidv7(), siloId, store: 'postgres' as const, bytesHeld: '1048576', bytesScanned: '2048',
      providerCost: '0.000300', costStorage: '0.000200', costCompute: '0.000100', period: '2026-11', measuredAt: new Date().toISOString(),
    });
    const bad = measurement(uuidv7());
    const good = measurement(silo);
    await relay(storageMeasuredMessage, bad);
    await relay(storageMeasuredMessage, good);
    await relay(storageMeasuredMessage, good);

    const deadline = Date.now() + 15_000;
    let rows: { id: string; bytes_held: string; provider_cost: string }[] = [];
    while (Date.now() < deadline) {
      rows = (await asOrg(() => app.query('select id, bytes_held, provider_cost::text from billing.storage_measurements where organisation_id = $1', [org]))).rows;
      if (rows.length > 0 && (await events('storage_measured')).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    rows = (await asOrg(() => app.query('select id, bytes_held, provider_cost::text from billing.storage_measurements where organisation_id = $1', [org]))).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.id, rows[0]!.bytes_held, rows[0]!.provider_cost], [good.measurementId, '1048576', '0.000300']);
    assert.equal((await events('storage_measured')).length, 1);
  });
});

describe('model usage from metering.usage (spec 7.8, 52.6, 73.5)', () => {
  test('provider tokens are recorded on the AI FDE task, recomputed from the call ledger; never a charge', async () => {
    const engagement = uuidv7();
    const stage = uuidv7();
    const servicePrincipal = uuidv7();
    const fdePrincipal = uuidv7();
    const task = uuidv7();
    await migrate.query(
      `insert into fde.fde_engagements (id, organisation_id, name, goals, engaging_membership_id, engagement_class, cell_id, token_budget,
         provider_cost_budget, rate_limits, model_route, started_at)
       values ($1, $2, 'Usage', 'Connect the ERP', $3, 'standard', $4, 10, 100, $5, 'default', now())`,
      [engagement, org, root.membershipId, CELL_ID, JSON.stringify({
        model_calls_per_minute: 10, probes_per_minute: 10, proposals_per_hour: 10, concurrent_tasks: 1, pending_proposals_per_decider: 5,
        attempts_per_task: 3,
      })]);
    await migrate.query(`insert into fde.fde_stages (id, organisation_id, engagement_id, stage_number, exit_criteria) values ($1, $2, $3, 1, '[]')`,
      [stage, org, engagement]);
    await migrate.query(
      `insert into iam.service_principals (id, organisation_id, kind, name, owner_membership_id, engagement_id, expires_at, created_by)
       values ($1, $2, 'fde', 'integration', $3, $4, now() + interval '30 days', $3)`, [servicePrincipal, org, root.membershipId, engagement]);
    await migrate.query(
      `insert into fde.fde_principals (id, organisation_id, engagement_id, service_principal_id, role, tool_permissions, created_by)
       values ($1, $2, $3, $4, 'integration', '{}', $5)`, [fdePrincipal, org, engagement, servicePrincipal, root.membershipId]);
    await migrate.query(
      `insert into fde.fde_tasks (id, organisation_id, engagement_id, stage_id, role, principal_id, kind, input_refs, max_attempts)
       values ($1, $2, $3, $4, 'integration', $5, 'draft_manifest', '{}', 3)`, [task, org, engagement, stage, fdePrincipal]);
    const call = async (input: number, output: number, thinking: number) => {
      const callId = uuidv7();
      await migrate.query(
        `insert into platform.model_calls (organisation_id, call_id, correlation_id, engagement_id, task_id, caller_service, request_type, model,
           model_route, input_tokens, output_tokens, thinking_tokens, prompt_hash, outcome, latency_ms)
         values ($1, $2, $3, $4, $5, 'fde-orchestrator', 'vocabulary', 'model-a', 'fde', $6, $7, $8, $9, 'ok', 120)`,
        [org, callId, uuidv7(), engagement, task, input, output, thinking, randomBytes(32)]);
      return {
        callId, callerService: 'fde-orchestrator', role: 'fde', requestType: 'vocabulary', route: 'fde', model: 'model-a', outcome: 'ok',
        inputTokens: input, outputTokens: output, thinkingTokens: thinking, membershipId: null, servicePrincipalId: servicePrincipal,
        engagementId: engagement, taskId: task, siloFileId: null,
      };
    };
    const charges = async () => Number((await one('select count(*)::int as n from billing.token_transactions where organisation_id = $1', [org])).n);
    const chargesBefore = await charges();
    const eventsBefore = (await asOrg(() => app.query(
      `select count(*)::int as n from platform.outbox where organisation_id = $1 and topic = 'audit.events'`, [org]))).rows[0].n as number;

    const first = await call(1200, 300, 100);
    const second = await call(800, 150, 0);
    await relay(modelUsageMessage, first);
    await relay(modelUsageMessage, second);
    await relay(modelUsageMessage, first); // redelivered
    await relay(modelUsageMessage, { ...second, taskId: null, engagementId: null }); // outside a task: nothing to record

    const deadline = Date.now() + 15_000;
    let row: { input: string; output: string } | undefined;
    while (Date.now() < deadline) {
      row = (await asOrg(() => app.query(
        'select provider_input_tokens::text as input, provider_output_tokens::text as output from fde.fde_tasks where id = $1', [task]))).rows[0];
      if (row?.input === '2000') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    row = (await asOrg(() => app.query(
      'select provider_input_tokens::text as input, provider_output_tokens::text as output from fde.fde_tasks where id = $1', [task]))).rows[0];
    assert.deepEqual(row, { input: '2000', output: '550' }, 'input 1200 + 800; output 300 + 100 thinking + 150');
    assert.equal(await charges(), chargesBefore, 'model usage never writes a charge');
    const eventsAfter = (await asOrg(() => app.query(
      `select count(*)::int as n from platform.outbox where organisation_id = $1 and topic = 'audit.events'`, [org]))).rows[0].n as number;
    assert.equal(eventsAfter, eventsBefore, 'nor a billing event');
  });
});
