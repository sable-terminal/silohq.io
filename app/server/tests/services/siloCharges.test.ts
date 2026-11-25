// Siloes at provider cost plus 10%, invoiced in arrears (spec 74.1, 74.2, 74.5): when a month
// closes, the real billing service sums each Silo store's measurements, takes off what the
// included storage covers, adds 10%, and invoices the lines through a small fake of the
// payment provider, each line stating its provider cost and its 10%. A customer reads the
// same lines under billing.view. A month is charged once; a month with nothing due is
// recorded and not billed.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { listSiloCharges } from '../../src/contracts/billing/siloCharges.contract.ts';
import { createBillingService } from '../../src/routes/billing/index.route.ts';
import { chargesFor, closedPeriod } from '../../src/services/billing/siloCharges.service.ts';
import type { Sweeps } from '../../src/services/billing/sweeps.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

type Json = Record<string, unknown>;
const GIB = 1024 ** 3;

let cell: ConnectCell;
let root: Signed;
let sweeps: Sweeps;
let now = new Date('2026-11-03T09:00:00Z');
let fake: { url: string; requests: { path: string; form: Record<string, string> }[]; close(): Promise<void> };
const archive = uuidv7();
const orders = uuidv7();

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
      if (path === '/v1/invoices') {
        const invoice: Json = {
          id: `in_${++n}`, object: 'invoice', customer: form['customer'], status: 'draft', amount_due: 0, currency: form['currency'],
          created: Math.floor(Date.now() / 1000), collection_method: form['collection_method'], metadata, lines: { data: [] as Json[] },
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
      if ((m = /^\/v1\/invoices\/(\w+)\/finalize$/.exec(path))) {
        const invoice = invoices.get(m[1]!)!;
        invoice['status'] = 'open';
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

/** The provider calls that make an invoice (the sweep's other passes may call it too). */
const invoiceCalls = (): number => fake.requests.filter((r) => r.path.startsWith('/v1/invoice')).length;
const rows = async (sql: string, params: unknown[] = []) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(sql, params))).rows;

async function measure(siloId: string, store: string, at: string, held: number, costs: { storage: string; compute?: string }, scanned = 0): Promise<void> {
  const compute = costs.compute ?? '0';
  await cell.migrate.query(
    `insert into billing.storage_measurements (id, organisation_id, silo_id, store, bytes_held, bytes_scanned, provider_cost, cost_storage,
       cost_compute, period, measured_at)
     values ($1, $2, $3, $4, $5, $6, $7::numeric + $8::numeric, $7, $8, to_char($9::timestamptz at time zone 'UTC', 'YYYY-MM'), $9)`,
    [uuidv7(), cell.org, siloId, store, held, scanned, costs.storage, compute, at]);
}

before(async () => {
  fake = await startFakeProvider();
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  await cell.start(createBillingService({ sweep: false, now: () => now, onSweeps: (s) => { sweeps = s; } }), 'billing', 'test_billing', {
    PAYMENTS_API_URL: fake.url, PAYMENTS_API_KEY: 'sk_test_fake_key_1234', PAYMENTS_WEBHOOK_SECRET: 'whsec_test_secret_5678',
  });
  // A live card subscription whose entitlement includes 10 GiB of Silo storage.
  const subscription = uuidv7();
  await cell.migrate.query(
    `insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id, stripe_subscription_id,
       current_period_start, current_period_end, status)
     values ($1, $2, 'business', 5, 'monthly', 'list', 'cus_live', 'sub_live', '2026-10-15', '2026-11-15', 'active')`, [subscription, cell.org]);
  await cell.migrate.query(
    `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit,
       storage_included_bytes, capabilities, source, subscription_id, effective_from)
     values ($1, $2, 5, 500, 5, 60, $3, '{}', 'subscription', $4, '2026-10-15')`, [uuidv7(), cell.org, 10 * GIB, subscription]);
  for (const [id, name] of [[archive, 'Archive'], [orders, 'Orders history']] as const) {
    await cell.migrate.query(
      `insert into siloes.siloes (id, organisation_id, kind, name, purpose, retention_days, location, created_by)
       values ($1, $2, 'capture', $3, 'history', 365, 'europe-west2', $4)`, [id, cell.org, name, root.membershipId]);
  }
  // October: the archive's Postgres held 10 then 30 GiB (a mean of 20); the orders' BigQuery
  // held 20 GiB and was queried. 40 GiB held on average, 10 included: a quarter of storage is free.
  await measure(archive, 'postgres', '2026-10-10T00:00:00Z', 10 * GIB, { storage: '1.000000' });
  await measure(archive, 'postgres', '2026-10-25T00:00:00Z', 30 * GIB, { storage: '2.000000' });
  await measure(orders, 'bigquery', '2026-10-10T00:00:00Z', 20 * GIB, { storage: '1.500000', compute: '0.400000' }, 2 ** 40);
  await measure(orders, 'bigquery', '2026-10-25T00:00:00Z', 20 * GIB, { storage: '1.500000', compute: '0.600000' }, 2 ** 40);
  // November so far: within what is included.
  await measure(archive, 'postgres', '2026-11-02T00:00:00Z', 5 * GIB, { storage: '0.500000' });
});

after(async () => {
  await cell?.close();
  await fake?.close();
});

describe('Siloes at provider cost plus 10% (74.1, 74.2)', () => {
  test('the arithmetic: included storage takes its share of storage only; 10% on what remains; the line to the penny', () => {
    assert.equal(closedPeriod(new Date('2026-01-04T00:00:00Z')), '2025-12');
    const charges = chargesFor([
      { siloId: archive, store: 'postgres', meanBytesHeld: 20n * BigInt(GIB), bytesScanned: 0n, bytesEgressed: 0n, costStorage: '3.000000', costCompute: '0.000000', costEgress: '0.000000' },
      { siloId: orders, store: 'bigquery', meanBytesHeld: 20n * BigInt(GIB), bytesScanned: 0n, bytesEgressed: 0n, costStorage: '3.000000', costCompute: '1.000000', costEgress: '0.000000' },
    ], 10n * BigInt(GIB));
    assert.deepEqual(charges.map((c) => [c.includedCost, c.providerCost, c.uplift, c.amount]), [
      ['0.750000', '2.250000', '0.225000', '2.48'], ['0.750000', '3.250000', '0.325000', '3.58'],
    ]);
    assert.deepEqual(chargesFor([{ ...charges[0]!, meanBytesHeld: BigInt(GIB) }], 10n * BigInt(GIB)).map((c) => c.amount), ['0.00'], 'all within what is included');
  });

  test('when October closes its lines are invoiced to the card, each stating the provider cost and the 10%', async () => {
    const counts = await sweeps.run(uuidv7());
    assert.equal(counts.siloInvoices, 1);
    const invoice = fake.requests.find((r) => r.path === '/v1/invoices')!;
    assert.deepEqual([invoice.form['customer'], invoice.form['collection_method'], invoice.form['metadata[period]']], ['cus_live', 'charge_automatically', '2026-10']);
    const items = fake.requests.filter((r) => r.path === '/v1/invoiceitems').map((r) => [r.form['description'], r.form['amount']]);
    assert.deepEqual(items.sort(), [
      ['Archive · Capture storage (Postgres), 2026-10: provider cost £2.25 + 10% £0.23', '248'],
      ['Orders history · BigQuery storage and queries, 2026-10: provider cost £3.25 + 10% £0.33', '358'],
    ]);
    const [mirrored] = await rows(`select id, amount, period_covered, status from billing.invoices where stripe_invoice_id is not null`);
    assert.deepEqual([mirrored.amount, mirrored.period_covered, mirrored.status], ['6.06', '2026-10', 'open']);
    const states = await rows(`select invoice_state, invoice_id from billing.silo_charges where period = '2026-10'`);
    assert.ok(states.length === 2 && states.every((s) => s.invoice_state === 'invoiced' && s.invoice_id === mirrored.id));
    const [event] = await rows(`select payload -> 'detail' as detail from platform.outbox where payload ->> 'event' = 'silo_charges_invoiced'`);
    assert.deepEqual(event.detail, { period: '2026-10', lines: 2, provider_cost: '5.500000', uplift: '0.550000', amount: '6.06' });
  });

  test('the customer sees the same lines: provider cost, the included storage and the 10%, never a blended rate', async () => {
    const out = await cell.client('gateway').call(listSiloCharges, { query: {} }, cell.as(root));
    assert.equal(out.period, '2026-10');
    const archiveLine = out.lines.find((l) => l.siloId === archive)!;
    assert.deepEqual([archiveLine.siloName, archiveLine.store, archiveLine.meanBytesHeld, archiveLine.costStorage, archiveLine.includedCost,
      archiveLine.providerCost, archiveLine.uplift, archiveLine.amount, archiveLine.invoiceState],
    ['Archive', 'postgres', String(20 * GIB), '3.000000', '0.750000', '2.250000', '0.225000', '2.48', 'invoiced']);
    assert.deepEqual(out.totals, { providerCost: '5.500000', uplift: '0.550000', amount: '6.06' });
  });

  test('a month is charged once: the sweep runs again and invoices nothing more', async () => {
    const before = invoiceCalls();
    assert.equal((await sweeps.run(uuidv7())).siloInvoices, 0);
    assert.equal(invoiceCalls(), before);
  });

  test('a month within the included storage is recorded and not billed', async () => {
    now = new Date('2026-12-01T09:00:00Z');
    const before = invoiceCalls();
    assert.equal((await sweeps.run(uuidv7())).siloInvoices, 0);
    assert.equal(invoiceCalls(), before, 'no invoice for nothing due');
    const [line] = await rows(`select included_cost, provider_cost, amount, invoice_state from billing.silo_charges where period = '2026-11'`);
    assert.deepEqual([line.included_cost, line.provider_cost, line.amount, line.invoice_state], ['0.500000', '0.000000', '0.00', 'not_billed']);
    const [event] = await rows(`select payload -> 'detail' ->> 'reason' as reason from platform.outbox where payload ->> 'event' = 'silo_charges_not_billed'`);
    assert.equal(event.reason, 'nothing_due');
  });
});
