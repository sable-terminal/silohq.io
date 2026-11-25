// Siloes at provider cost plus 10% (spec 74.1, 74.2, 74.5), invoiced in arrears.
//
// When a month closes, each organisation's storage measurements for it (Capture's Postgres
// from siloes-capture; Import's BigQuery and the Object Index from bigquery-metering) are
// summed per Silo and store into charges: the provider cost of storage, compute and egress,
// less what the entitlement's included storage covers, plus 10%. Each charge is one invoice
// line stating its provider cost and its 10%, never a blended rate (74.1 binding rule).
//
// - Included storage (74.2): storage_included_bytes covers a share of the month's storage.
//   The organisation's held bytes are the mean of each Silo store's measurements, summed;
//   holding no more than is included, no storage is billed; above it, each line's storage
//   cost is billed less its included share (included / held). Compute and egress always bill.
// - The invoice: a self-serve subscription's card is charged automatically; an Enterprise
//   contract's invoice is sent with its payment terms and purchase order. With neither, or
//   nothing due, the charges are recorded and not billed.
// - Once: charges are keyed by organisation, month, Silo and store, and the provider invoice
//   by organisation and month, so a sweep that stopped part way finds what it made.
// - Exact: costs are micro-pounds (bigint) until the line is rounded to the penny.

import type { SiloChargeLine } from '../../contracts/billing/siloCharges.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { SiloCharge } from '../../models/billing/index.model.ts';
import { contractRepo, entitlementRepo, siloChargeRepo, storageMeasurementRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { siloRepo } from '../../repos/siloes/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordEvent, requirePermission, SYSTEM, type BillingDeps } from './deps.service.ts';
import { daysFromTerms } from './invoicing.service.ts';
import { upsertProviderInvoice } from './webhook.service.ts';

export type Store = 'postgres' | 'gcs' | 'bigquery' | 'index';

/** One Silo store's month, as the measurements sum to. Pounds as six-decimal strings. */
export interface PeriodTotal {
  siloId: string;
  store: Store;
  meanBytesHeld: bigint;
  bytesScanned: bigint;
  bytesEgressed: bigint;
  costStorage: string;
  costCompute: string;
  costEgress: string;
}

export interface Charge extends PeriodTotal {
  includedCost: string;
  providerCost: string;
  uplift: string;
  amount: string;
}

const STORE_LABEL: Record<Store, string> = {
  postgres: 'Capture storage (Postgres)', gcs: 'Import files (Cloud Storage)', bigquery: 'BigQuery storage and queries', index: 'Object Index',
};

/** Pounds as micro-pounds: '4.80' is 4_800_000n. */
export function micros(pounds: string): bigint {
  const negative = pounds.startsWith('-');
  const [whole, fraction = ''] = (negative ? pounds.slice(1) : pounds).split('.');
  const value = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  return negative ? -value : value;
}

/** Micro-pounds as pounds with six decimals. */
export const pounds = (value: bigint): string => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;

/** Pence as pounds with two decimals. */
const fromPence = (value: bigint): string => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;

/** a / b, rounded half up, for non-negative integers. */
const divide = (a: bigint, b: bigint): bigint => (a + b / 2n) / b;

/** The month's charges, from its totals and the bytes included (pure). */
export function chargesFor(totals: readonly PeriodTotal[], includedBytes: bigint): Charge[] {
  const held = totals.reduce((n, t) => n + t.meanBytesHeld, 0n);
  return totals.map((t) => {
    const storage = micros(t.costStorage);
    const included = includedBytes <= 0n || held === 0n ? 0n : includedBytes >= held ? storage : divide(storage * includedBytes, held);
    const provider = storage - included + micros(t.costCompute) + micros(t.costEgress);
    const uplift = divide(provider, 10n);
    return { ...t, includedCost: pounds(included), providerCost: pounds(provider), uplift: pounds(uplift), amount: fromPence(divide(provider + uplift, 10_000n)) };
  });
}

/** Pounds to the penny, from six decimals, for a line's description. */
const display = (value: string): string => fromPence(divide(micros(value), 10_000n));

/** The invoice line's words: the Silo, the store, the month, the provider cost and the 10%. */
export function lineDescription(siloName: string, store: Store, period: string, providerCost: string, uplift: string): string {
  return `${siloName} · ${STORE_LABEL[store]}, ${period}: provider cost £${display(providerCost)} + 10% £${display(uplift)}`.slice(0, 500);
}

/** The month before the one `now` falls in, as YYYY-MM. */
export function closedPeriod(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** The month's last instant, for the invoice's service period. */
const periodBounds = (period: string): { start: string; end: string } => {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(year, month - 1, 1)).toISOString(), end: new Date(Date.UTC(year, month, 1) - 1000).toISOString() };
};

export type ChargeOutcome = 'invoiced' | 'not_billed' | 'done';

export function createSiloCharges(deps: BillingDeps) {
  const control = deps.databases.pool('control');

  /** Makes the month's charges once, and invoices what is pending. */
  async function chargeOrganisation(organisationId: string, period: string, correlationId: string): Promise<ChargeOutcome> {
    const request = { organisationId };
    const loaded = await inTransaction(control, request, async (db) => {
      let charges = await siloChargeRepo.forPeriod(db, period);
      if (charges.length === 0) {
        const totals = await storageMeasurementRepo.periodTotals(db, period);
        const included = BigInt((await entitlementRepo.findOpen(db, organisationId))?.storageIncludedBytes ?? 0);
        for (const c of chargesFor(totals, included)) {
          await siloChargeRepo.insert(db, {
            id: uuidv7(), organisationId, period, siloId: c.siloId, store: c.store, meanBytesHeld: String(c.meanBytesHeld),
            bytesScanned: String(c.bytesScanned), bytesEgressed: String(c.bytesEgressed), costStorage: c.costStorage, costCompute: c.costCompute,
            costEgress: c.costEgress, includedCost: c.includedCost, providerCost: c.providerCost, uplift: c.uplift, amount: c.amount,
          });
        }
        charges = await siloChargeRepo.forPeriod(db, period);
      }
      const pending = charges.filter((c) => c.invoiceState === 'pending');
      const names = new Map<string, string>();
      for (const siloId of new Set(pending.map((c) => c.siloId))) names.set(siloId, (await siloRepo.findById(db, siloId))?.name ?? 'Silo');
      return {
        pending, names, subscription: await subscriptionRepo.findLive(db, organisationId), contract: await contractRepo.findActive(db, organisationId),
        organisationName: (await organisationRepo.findById(db, organisationId))?.name ?? 'Organisation',
      };
    });
    const { pending, names, subscription, contract } = loaded;
    if (pending.length === 0) return 'done';
    const due = pending.filter((c) => micros(c.amount) > 0n);
    const totals = summed(pending);
    const notBilled = async (reason: 'nothing_due' | 'no_payment_relationship') => {
      await inTransaction(control, request, async (db) => {
        await siloChargeRepo.setState(db, pending.map((c) => c.id), 'not_billed', null);
        await recordEvent(db, {
          organisationId, correlationId, event: 'silo_charges_not_billed', actor: SYSTEM,
          detail: { period, lines: pending.length, provider_cost: totals.providerCost, uplift: totals.uplift, amount: totals.amount, reason },
        });
      });
      return 'not_billed' as const;
    };
    if (due.length === 0) return notBilled('nothing_due');
    let customerId = subscription?.stripeCustomerId ?? contract?.stripeCustomerId ?? null;
    if (subscription === undefined && contract === undefined) return notBilled('no_payment_relationship');
    if (customerId === null) {
      // An Enterprise customer is created once, under the contract, as for its other invoices.
      customerId = (await deps.payments.createCustomer({ organisationId, cellId: deps.config.cell.id, name: loaded.organisationName },
        `contract-customer:${contract!.id}`)).id;
      await inTransaction(control, request, (db) => contractRepo.update(db, contract!.id, { stripeCustomerId: customerId }));
    }
    const bounds = periodBounds(period);
    const invoice = await deps.payments.createUsageInvoice({
      customerId, currency: 'GBP',
      collection: subscription !== undefined ? { kind: 'automatic' } : { kind: 'send_invoice', daysUntilDue: daysFromTerms(contract!.paymentTerms) },
      lines: due.map((c) => ({
        description: lineDescription(names.get(c.siloId)!, c.store, period, c.providerCost, c.uplift),
        amountMinor: Number(micros(c.amount) / 10_000n),
      })),
      purchaseOrder: subscription === undefined ? contract!.purchaseOrderRef ?? undefined : undefined,
      periodStart: bounds.start, periodEnd: bounds.end,
      metadata: { organisation_id: organisationId, cell_id: deps.config.cell.id, kind: 'silo_charges', period },
    }, `silo-charges:${organisationId}:${period}`);
    await inTransaction(control, request, async (db) => {
      const status = await organisationRepo.lockBillingStatus(db, organisationId);
      const row = await upsertProviderInvoice(db, organisationId, invoice, subscription === undefined ? contract!.id : null, status!, correlationId);
      await siloChargeRepo.setState(db, due.map((c) => c.id), 'invoiced', row.id);
      const nothing = pending.filter((c) => micros(c.amount) === 0n);
      if (nothing.length > 0) await siloChargeRepo.setState(db, nothing.map((c) => c.id), 'not_billed', null);
      await recordEvent(db, {
        organisationId, correlationId, event: 'silo_charges_invoiced', actor: SYSTEM, resource: { type: 'invoice', id: row.id },
        detail: { period, lines: due.length, provider_cost: totals.providerCost, uplift: totals.uplift, amount: totals.amount },
      });
    });
    return 'invoiced';
  }

  return {
    chargeOrganisation,

    /** The closed month's charges for every organisation due, and any still pending from before. */
    async sweep(period: string, correlationId: string, batch = 200): Promise<{ invoiced: number; notBilled: number }> {
      const counts = { invoiced: 0, notBilled: 0 };
      const due = await inTransaction(control, {}, (db) => siloChargeRepo.due(db, period, batch), { readOnly: true });
      for (const { organisationId, period: month } of due) {
        try {
          const outcome = await chargeOrganisation(organisationId, month, correlationId);
          if (outcome === 'invoiced') counts.invoiced += 1;
          if (outcome === 'not_billed') counts.notBilled += 1;
        } catch (error) {
          // Pending charges stay pending; the next sweep invoices them with the same key.
          deps.logger.failure('a month\'s Silo charges were not invoiced; the next sweep retries', error, {
            event: 'billing.silo_charges_failed', organisationId,
          });
        }
      }
      return counts;
    },

    /** billing.view: a month's lines, each with its provider cost and its 10%. */
    async list(ctx: HandlerContext, period: string | undefined) {
      await requirePermission(deps, ctx, 'billing.view');
      return inTransaction(control, ctx.request, async (db) => {
        const month = period ?? await siloChargeRepo.latestPeriod(db);
        const charges = month === undefined ? [] : await siloChargeRepo.forPeriod(db, month);
        const names = new Map<string, string>();
        for (const siloId of new Set(charges.map((c) => c.siloId))) names.set(siloId, (await siloRepo.findById(db, siloId))?.name ?? 'Silo');
        const lines: SiloChargeLine[] = charges.map((c) => ({
          siloId: c.siloId, siloName: names.get(c.siloId)!, store: c.store, meanBytesHeld: c.meanBytesHeld, bytesScanned: c.bytesScanned,
          bytesEgressed: c.bytesEgressed, costStorage: c.costStorage, costCompute: c.costCompute, costEgress: c.costEgress,
          includedCost: c.includedCost, providerCost: c.providerCost, uplift: c.uplift, amount: c.amount, invoiceState: c.invoiceState,
          invoiceId: c.invoiceId,
        }));
        return { period: month ?? null, lines, totals: summed(charges) };
      }, { readOnly: true });
    },
  };
}

/** A month's totals: provider cost and uplift to the micro-pound, the amount as the lines' pence add up. */
function summed(charges: readonly Pick<SiloCharge, 'providerCost' | 'uplift' | 'amount'>[]) {
  const sum = (pick: (c: Pick<SiloCharge, 'providerCost' | 'uplift' | 'amount'>) => string) => charges.reduce((n, c) => n + micros(pick(c)), 0n);
  return { providerCost: pounds(sum((c) => c.providerCost)), uplift: pounds(sum((c) => c.uplift)), amount: fromPence(divide(sum((c) => c.amount), 10_000n)) };
}

export type SiloCharges = ReturnType<typeof createSiloCharges>;
