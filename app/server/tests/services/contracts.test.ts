// Enterprise contracts end to end (spec 71.3, 72, 74.3 to 74.8, 75.3): the real billing
// service on a fresh cell, called as the admin portal names a member of staff, against a
// small fake of the payment provider's invoicing API.
//
// What it shows: a quote is priced with the unmeasured warning; below the floor it waits for
// sign-off by someone other than its author; activation brings entitlements, seats and the
// Enterprise plan; only staff write a contract (the service and the database both refuse
// otherwise); the customer sees its terms but never the margin; amendments and renewals are
// new entitlement versions and move seats; a Stripe invoice carries the purchase order and is
// sent with terms; a manual invoice is paid by staff, named; an overdue invoice moves the
// organisation to past due and paying it lifts that; overage is reported once as it grows,
// never charged; and an unrenewed contract lapses at term end.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import * as bc from '../../src/contracts/billing/contract.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createBillingService } from '../../src/routes/billing/index.route.ts';
import type { Sweeps } from '../../src/services/billing/sweeps.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell } from './connect.helper.ts';

type Json = Record<string, unknown>;

let cell: ConnectCell;
let staff: ServiceClient;
let fake: { url: string; requests: { path: string; form: Record<string, string> }[]; close(): Promise<void> };
let sweeps: Sweeps;
let clock = (): Date => new Date();
const alice = uuidv7();
const bob = uuidv7();

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function startFakeProvider() {
  const requests: { path: string; form: Record<string, string> }[] = [];
  const invoices = new Map<string, Json>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      requests.push({ path, form });
      const send = (body: Json): void => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
      const metadata = Object.fromEntries(Object.entries(form).filter(([k]) => /^metadata\[\w+\]$/.test(k)).map(([k, v]) => [k.slice(9, -1), v]));
      let m: RegExpExecArray | null;
      if (path === '/v1/customers') return send({ id: `cus_${++n}`, object: 'customer', metadata });
      if (path === '/v1/invoices') {
        const invoice: Json = {
          id: `in_${++n}`, object: 'invoice', customer: form['customer'], status: 'draft', amount_due: 0, currency: form['currency'],
          created: Math.floor(Date.now() / 1000), collection_method: form['collection_method'], days_until_due: Number(form['days_until_due']),
          metadata, lines: { data: [] as Json[] },
        };
        invoices.set(invoice['id'] as string, invoice);
        return send(invoice);
      }
      if (path === '/v1/invoiceitems') {
        const invoice = invoices.get(form['invoice']!)!;
        invoice['amount_due'] = (invoice['amount_due'] as number) + Number(form['amount']);
        (invoice['lines'] as { data: Json[] }).data.push({ period: { start: Number(form['period[start]']), end: Number(form['period[end]']) } });
        return send({ id: `ii_${++n}` });
      }
      if ((m = /^\/v1\/invoices\/(\w+)\/(finalize|send)$/.exec(path))) {
        const invoice = invoices.get(m[1]!)!;
        invoice['status'] = 'open';
        invoice['due_date'] = (invoice['created'] as number) + (invoice['days_until_due'] as number) * 86_400;
        return send(invoice);
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

before(async () => {
  fake = await startFakeProvider();
  cell = await createConnectCell();
  for (const [id, name] of [[alice, 'Alice Sales'], [bob, 'Bob Finance']] as const) {
    await cell.migrate.query(
      `insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed, status)
       values ($1, $2, $3, 'sc', true, false, 'active')`, [id, `sub-${id}`, name]);
  }
  await cell.start(createBillingService({ sweep: false, now: () => clock(), onSweeps: (s) => { sweeps = s; } }), 'billing', 'test_billing', {
    PAYMENTS_API_URL: fake.url, PAYMENTS_API_KEY: 'sk_test_fake_key_1234', PAYMENTS_WEBHOOK_SECRET: 'whsec_test_secret_5678',
  });
  staff = cell.client('admin-portal');
});

after(async () => {
  await cell?.close();
  await fake?.close();
});

const as = (operatorId?: string) => ({ request: { organisationId: cell.org, ...(operatorId ? { operatorId } : {}) }, correlationId: uuidv7() });
const asOrg = <T>(work: () => Promise<T>): Promise<T> => inTx(cell.app, { orgId: cell.org }, work);
const rows = async (sql: string, params: unknown[] = []) => (await asOrg(() => cell.app.query(sql, params))).rows;
const events = async (name: string): Promise<Json[]> => (await rows(
  `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at, id`,
  [cell.org, name])).map((r) => r.detail as Json);
const billingStatus = async (): Promise<string> => (await rows('select billing_status as s from iam.organisations where id = $1', [cell.org]))[0]!.s;

const terms = (overrides: Partial<(typeof bc.contractTerms)['_input']> = {}) => ({
  platformFee: '24000', seatCount: 10, seatRate: '60', tokenAllocation: 500, dailyTokenLimit: 60, simulationAllocation: 5,
  storageIncludedBytes: 50 * 1024 ** 3, termStart: day(-10), termEnd: day(355), paymentTerms: 'net 30', purchaseOrderRef: 'PO-4471',
  capabilities: ['sso', 'scim'] as ('sso' | 'scim')[], ...overrides,
});

let contractId = '';
let version = '';

describe('Enterprise contracts (74.3, 74.4)', () => {
  test('a quote is priced over the term and warns until fifty compiles are logged', async () => {
    const quote = await staff.call(bc.quoteContract, { body: { terms: terms() } }, as(alice));
    assert.equal(quote.termMonths, 13);
    assert.equal(quote.measured, false);
    assert.match(quote.warning!, /fifty compiles/);
    assert.ok(quote.price > 0 && quote.cost.total > 0);
  });

  test('below the floor a quote waits for sign-off by someone other than its author', async () => {
    const created = await staff.call(bc.createContract, { body: { terms: terms({ seatRate: '5', platformFee: '0' }) } }, as(alice));
    assert.equal(created.contract.status, 'awaiting_margin_approval');
    assert.equal(created.quote.belowFloor, true);
    contractId = created.contract.id;
    version = created.contract.version;
    assert.equal((await events('margin_approval_requested'))[0]!['operator_id'], alice);
    await assert.rejects(staff.call(bc.activateContract, { params: { contractId }, body: { version, signedBy: 'Jane Customer' } }, as(bob)),
      { code: 'contract.margin_unapproved' });
    await assert.rejects(staff.call(bc.approveContractMargin, { params: { contractId }, body: { version } }, as(alice)),
      { code: 'contract.margin_self_approval' });
    const approved = await staff.call(bc.approveContractMargin, { params: { contractId }, body: { version } }, as(bob));
    assert.equal(approved.status, 'draft');
    assert.equal(approved.marginApprovedBy, bob);
    version = approved.version;
    assert.equal((await events('margin_approval_granted'))[0]!['operator_id'], bob);
  });

  test('only staff write a contract: the service refuses a request with no member of staff, and so does the database', async () => {
    await assert.rejects(staff.call(bc.createContract, { body: { terms: terms() } }, as()), { code: 'billing.staff_required' });
    await assert.rejects(asOrg(() => cell.app.query(`update billing.contracts set seat_count = 99 where id = $1`, [contractId]).then((r) => {
      if (r.rowCount === 0) throw Object.assign(new Error('no row'), { code: 'rls' });
    })), { code: 'rls' });
  });

  test('activation brings the contract\'s entitlements, its seats and the Enterprise plan', async () => {
    const active = await staff.call(bc.activateContract, { params: { contractId }, body: { version, signedBy: 'Jane Customer' } }, as(bob));
    assert.equal(active.status, 'active');
    assert.equal(active.countersignedBy, bob);
    version = active.version;
    const [entitlement] = await rows(`select * from billing.entitlements where organisation_id = $1 and effective_to is null`, [cell.org]);
    assert.equal(entitlement!.source, 'contract');
    assert.equal(entitlement!.contract_id, contractId);
    assert.equal(entitlement!.tokens_per_seat_period, 500);
    assert.equal(entitlement!.seats, 10);
    assert.deepEqual(entitlement!.capabilities, ['sso', 'scim', 'ai_connector_builder', 'nocode_connector_builder'], 'every contract carries both builders (D76)');
    assert.equal(entitlement!.connections_limit, null, 'Enterprise connections are unlimited');
    assert.equal((await rows(`select count(*)::int as n from billing.seats where contract_id = $1 and plan_tier = 'enterprise'`, [contractId]))[0]!.n, 10);
    assert.equal((await rows('select plan from iam.organisations where id = $1', [cell.org]))[0]!.plan, 'enterprise');
    assert.equal((await events('contract_created'))[0]!['operator_id'], bob);
  });

  test('the customer sees its contract as signed, never the margin or who quoted it', async () => {
    const root = await cell.signIn('root@acme.example');
    const own = await cell.client('gateway').call(bc.readOwnContracts, {}, cell.as(root));
    assert.equal(own.contracts.length, 1);
    assert.equal(own.contracts[0]!.signedBy, 'Jane Customer');
    for (const hidden of ['quotedMargin', 'marginApprovedBy', 'createdBy', 'countersignedBy']) assert.ok(!(hidden in own.contracts[0]!), hidden);
  });

  test('an amendment is a new entitlement version; below the floor the quote\'s author cannot sign it off', async () => {
    await assert.rejects(staff.call(bc.amendContract, { params: { contractId }, body: { version, changes: { seatCount: 8 } } }, as(alice)),
      { code: 'contract.margin_needs_another' });
    const { contract } = await staff.call(bc.amendContract, { params: { contractId }, body: { version, changes: { seatCount: 8, tokenAllocation: 400 } } }, as(bob));
    version = contract.version;
    assert.equal(contract.seatCount, 8);
    const versions = await rows(`select tokens_per_seat_period as t, effective_to from billing.entitlements where organisation_id = $1 order by effective_from`, [cell.org]);
    assert.deepEqual(versions.map((v) => [v.t, v.effective_to === null]).slice(-2), [[500, false], [400, true]]);
    assert.equal((await rows(`select count(*)::int as n from billing.seats where contract_id = $1 and status <> 'released'`, [contractId]))[0]!.n, 8);
    assert.equal((await events('contract_amended'))[0]!['changed'], 'seatCount,tokenAllocation');
    assert.equal((await events('live_bounds_changed')).length, 0, 'the cell\'s default live bound, unchanged');

    // The live bound is contractual on Enterprise (9.5): it moves with the contract, and the state plane reads it from the entitlement.
    const bounded = await staff.call(bc.amendContract, { params: { contractId }, body: { version, changes: { liveObjectsLimit: 2_000_000 } } }, as(bob));
    version = bounded.contract.version;
    assert.equal(bounded.contract.liveObjectsLimit, 2_000_000);
    assert.equal((await rows(`select live_objects_limit from billing.entitlements where organisation_id = $1 and effective_to is null`, [cell.org]))[0]!.live_objects_limit,
      2_000_000);
    const changed = await events('live_bounds_changed');
    assert.deepEqual(changed.map((d) => [d['bound'], d['from'], d['to']]), [['live_objects_per_organisation', null, 2_000_000]]);
  });
});

describe('invoices, manual payments and billing status (74.5, 74.6, 75.3)', () => {
  test('a contract invoice is sent through Stripe Invoicing with its terms and purchase order, and mirrored', async () => {
    const invoice = await staff.call(bc.raiseContractInvoice, { params: { contractId }, body: {
      lines: [{ description: 'Platform fee, year one', amount: '24000' }, { description: '8 seats x 12 months', amount: '5760.50' }],
      periodStart: day(-10), periodEnd: day(355), requestKey: uuidv7(),
    } }, as(bob));
    assert.equal(invoice.status, 'open');
    assert.equal(invoice.amount, '29760.50');
    assert.equal(invoice.contractId, contractId);
    assert.equal(invoice.terms, 'net 30');
    const created = fake.requests.find((r) => r.path === '/v1/invoices')!;
    assert.equal(created.form['collection_method'], 'send_invoice');
    assert.equal(created.form['custom_fields[0][value]'], 'PO-4471');
    assert.ok(fake.requests.some((r) => /\/send$/.test(r.path)), 'the invoice is sent');
    assert.equal((await events('invoice_raised')).length, 1);
  });

  test('an overdue invoice moves the organisation to past due; paying it, recorded by named staff, lifts it', async () => {
    const manual = await staff.call(bc.recordManualInvoice, { body: {
      contractId, periodCovered: day(-40).slice(0, 7), amount: '1200', terms: 'net 30, supplier portal', dueDate: day(-1),
    } }, as(bob));
    assert.equal(manual.manual, true);
    assert.equal(manual.stripeInvoiceId, null);
    const swept = await sweeps.run(uuidv7());
    assert.equal(swept.overdue, 1);
    assert.equal(await billingStatus(), 'past_due');
    const [changed] = await events('billing_status_changed');
    assert.deepEqual([changed!['to'], changed!['source'], changed!['invoice_id']], ['past_due', 'overdue_invoice', manual.id]);
    const stripeInvoice = (await rows(`select id from billing.invoices where stripe_invoice_id is not null`))[0]!.id as string;
    await assert.rejects(staff.call(bc.recordManualPayment, { params: { invoiceId: stripeInvoice }, body: {} }, as(alice)), { code: 'invoice.not_manual' });
    const paid = await staff.call(bc.recordManualPayment, { params: { invoiceId: manual.id }, body: {} }, as(alice));
    assert.equal(paid.status, 'paid');
    assert.equal(paid.recordedBy, alice);
    assert.equal((await events('payment_recorded_manually'))[0]!['operator_id'], alice);
    assert.equal(await billingStatus(), 'active');
    assert.equal((await events('billing_status_changed')).at(-1)!['source'], 'overdue_invoices_paid');
  });

  test('overage accrues and is reported as it grows, never charged (74.3)', async () => {
    const usage = await staff.call(bc.contractUsage, { params: { contractId } }, as(bob));
    const over = usage.tokensAllocatedToDate + 1_234;
    await cell.migrate.query(
      `insert into billing.token_transactions (organisation_id, membership_id, operation, pool, weight, source, correlation_id)
       values ($1, null, 'compile', 'tokens', $2, 'contract', $3)`, [cell.org, over, uuidv7()]);
    assert.equal((await sweeps.run(uuidv7())).overageReported, 1);
    assert.equal((await sweeps.run(uuidv7())).overageReported, 0, 'reported once until it grows');
    const [report] = await events('overage_reported');
    assert.equal(report!['overage'], 1_234);
    assert.equal((await staff.call(bc.contractUsage, { params: { contractId } }, as(bob))).overage, 1_234);
  });
});

describe('term end (74.3)', () => {
  test('an unrenewed contract lapses at term end; its entitlements stand until staff renew it', async () => {
    const [current] = (await staff.call(bc.listContracts, { query: {} }, as(bob))).contracts;
    clock = () => new Date(Date.parse(`${current!.termEnd}T12:00:00Z`) + 86_400_000);
    assert.equal((await sweeps.run(uuidv7())).lapsed, 1);
    const [lapsed] = (await staff.call(bc.listContracts, { query: {} }, as(bob))).contracts;
    assert.deepEqual([lapsed!.status, lapsed!.renewalState], ['expired', 'lapsed']);
    assert.equal((await events('contract_lapsed')).length, 1);
    assert.equal((await rows(`select count(*)::int as n from billing.entitlements where organisation_id = $1 and effective_to is null and contract_id = $2`,
      [cell.org, contractId]))[0]!.n, 1);
    const { contract } = await staff.call(bc.renewContract, { params: { contractId }, body: {
      version: lapsed!.version, termEnd: day(720), changes: { seatCount: 8, tokenAllocation: 400 },
    } }, as(bob));
    assert.deepEqual([contract.status, contract.renewalState, contract.termEnd], ['active', 'renewed', day(720)]);
    assert.equal((await events('contract_renewed'))[0]!['after_lapse'], true);
    // Within the notice window of the new term, the next renewal is upcoming.
    clock = () => new Date(Date.parse(`${day(720)}T12:00:00Z`) - 30 * 86_400_000);
    assert.equal((await sweeps.run(uuidv7())).upcoming, 1);
    assert.equal((await staff.call(bc.listContracts, { query: {} }, as(bob))).contracts[0]!.renewalState, 'upcoming');
  });
});
