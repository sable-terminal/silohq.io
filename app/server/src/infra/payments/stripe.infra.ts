// The payment provider adapter: Stripe's REST API over fetch (form-encoded requests, a
// secret key, an Idempotency-Key on every write) and its webhook signature scheme. No SDK.
// Only this folder knows the provider; the billing service sees payments.infra.ts.
//
// Webhook signature (Stripe's documented scheme): the Stripe-Signature header carries
// t=<unix seconds> and one or more v1=<hex>. Each v1 is HMAC-SHA256, keyed by the
// endpoint's signing secret, of "<t>.<raw body>". An event is accepted when one v1 matches
// in constant time and t is within the tolerance of now, which bounds replay.
//
// Writes are retried only under their idempotency key, and reads freely, on a network
// failure, a 429 or a 5xx. The provider's error text never leaves here: an error carries
// its HTTP status and the provider's error type and code.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentsConfig } from '../../config/payments.config.ts';
import { AppError } from '../../utils/errors.util.ts';
import { retry } from '../../utils/retry.util.ts';
import type {
  ChargeOutcome, PaymentEvent, PaymentInvoice, PaymentProvider, PaymentSubscription, ProviderSubscriptionStatus,
} from './payments.infra.ts';

type Json = Record<string, unknown>;
type Params = Record<string, unknown>;

/** Nested parameters in the provider's bracket form: metadata[organisation_id]=..., line_items[0][price]=... */
export function encodeForm(params: Params, prefix?: string, out: string[] = []): string[] {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix === undefined ? key : `${prefix}[${key}]`;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object') encodeForm(item as Params, `${name}[${index}]`, out);
        else out.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      encodeForm(value as Params, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out;
}

const SIGNATURE_PART = /^(t|v1)=([0-9a-f]+)$/;

/** Signs a payload as the provider does; for tests and local fakes. */
export function signPayload(payload: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex')}`;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asObject = (value: unknown): Json | undefined =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined);
const idOf = (value: unknown): string | undefined => asString(value) ?? asString(asObject(value)?.['id']);
const iso = (seconds: unknown): string | undefined =>
  (typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined);

function metadataOf(...sources: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(asObject(source) ?? {})) if (typeof value === 'string') out[key] ??= value;
  }
  return out;
}

const unexpected = (what: string): AppError =>
  new AppError('upstream', `the payment provider returned an unexpected ${what}`, { code: 'payments.unexpected_response' });

const SUBSCRIPTION_STATUSES: readonly ProviderSubscriptionStatus[] = [
  'active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused',
];

export function readSubscription(o: Json): PaymentSubscription {
  const item = asObject((asObject(o['items'])?.['data'] as unknown[] | undefined)?.[0]);
  const status = o['status'] as ProviderSubscriptionStatus;
  const id = asString(o['id']);
  const customerId = idOf(o['customer']);
  // Newer API versions keep the period on the item.
  const start = iso(o['current_period_start']) ?? iso(item?.['current_period_start']);
  const end = iso(o['current_period_end']) ?? iso(item?.['current_period_end']);
  if (!id || !customerId || !SUBSCRIPTION_STATUSES.includes(status) || !start || !end) throw unexpected('subscription');
  const quantity = typeof item?.['quantity'] === 'number' ? item['quantity'] : typeof o['quantity'] === 'number' ? o['quantity'] : 1;
  return {
    id, customerId, status, quantity,
    priceId: idOf(item?.['price']) ?? idOf(item?.['plan']),
    currentPeriodStart: start, currentPeriodEnd: end,
    cancelledAt: iso(o['canceled_at']) ?? iso(o['ended_at']) ?? null,
    metadata: metadataOf(o['metadata']),
  };
}

const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;

export function readInvoice(o: Json): PaymentInvoice {
  const line = asObject((asObject(o['lines'])?.['data'] as unknown[] | undefined)?.[0]);
  const period = asObject(line?.['period']);
  const parent = asObject(asObject(o['parent'])?.['subscription_details']);
  const id = asString(o['id']);
  const customerId = idOf(o['customer']);
  const status = o['status'] as PaymentInvoice['status'];
  const createdAt = iso(o['created']);
  const amountDue = typeof o['amount_due'] === 'number' ? o['amount_due'] : typeof o['total'] === 'number' ? o['total'] : undefined;
  const currency = asString(o['currency']);
  if (!id || !customerId || !INVOICE_STATUSES.includes(status) || !createdAt || amountDue === undefined || !currency) throw unexpected('invoice');
  const dueSeconds = o['due_date'];
  return {
    id, customerId, status, amountDue, currency: currency.toUpperCase(), createdAt,
    subscriptionId: idOf(o['subscription']) ?? idOf(parent?.['subscription']) ?? null,
    periodStart: iso(period?.['start']) ?? iso(o['period_start']) ?? createdAt,
    periodEnd: iso(period?.['end']) ?? iso(o['period_end']) ?? createdAt,
    dueDate: typeof dueSeconds === 'number' ? new Date(dueSeconds * 1000).toISOString().slice(0, 10) : null,
    paidAt: iso(asObject(o['status_transitions'])?.['paid_at']) ?? null,
    collection: o['collection_method'] === 'send_invoice' ? 'send_invoice' : 'automatic',
    daysUntilDue: typeof o['days_until_due'] === 'number' ? o['days_until_due'] : null,
    metadata: metadataOf(o['metadata'], asObject(o['subscription_details'])?.['metadata'], parent?.['metadata']),
  };
}

export function createStripePayments(config: PaymentsConfig): PaymentProvider {
  const { apiKey, webhookSecret } = config;
  if (apiKey === undefined || webhookSecret === undefined) {
    throw new AppError('configuration', 'billing needs PAYMENTS_API_KEY and PAYMENTS_WEBHOOK_SECRET', { code: 'config.payments' });
  }

  async function once(method: 'GET' | 'POST', path: string, params: Params, idempotencyKey: string | undefined): Promise<Json> {
    const body = encodeForm(params).join('&');
    const url = method === 'GET' && body !== '' ? `${config.apiUrl}${path}?${body}` : `${config.apiUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (cause) {
      throw new AppError('unavailable', 'the payment provider could not be reached', { code: 'payments.unreachable', cause, retryable: true });
    }
    let json: Json;
    try {
      json = asObject(await response.json()) ?? {};
    } catch {
      json = {};
    }
    if (response.ok) return json;
    const error = asObject(json['error']);
    const details = {
      status: response.status,
      ...(asString(error?.['type']) ? { providerType: asString(error?.['type'])! } : {}),
      ...(asString(error?.['code']) ? { providerCode: asString(error?.['code'])! } : {}),
      ...(asString(error?.['decline_code']) ? { declineCode: asString(error?.['decline_code'])! } : {}),
    };
    if (response.status === 429 || response.status >= 500) {
      throw new AppError('unavailable', 'the payment provider is unavailable', { code: 'payments.unavailable', details, retryable: true });
    }
    throw new AppError('upstream', 'the payment provider refused the request', {
      code: response.status === 402 ? 'payments.card_declined' : 'payments.refused', details, retryable: false,
    });
  }

  // Reads retry freely; a write retries only under its idempotency key, so a repeat is the same write.
  const request = (method: 'GET' | 'POST', path: string, params: Params = {}, idempotencyKey?: string): Promise<Json> =>
    retry(() => once(method, path, params, idempotencyKey), {
      attempts: method === 'GET' || idempotencyKey !== undefined ? 3 : 1, baseDelayMs: 200, maxDelayMs: 2_000,
    });

  const segment = (id: string): string => {
    if (!/^[A-Za-z0-9_]{1,255}$/.test(id)) throw new AppError('validation', 'not a provider identifier', { code: 'payments.bad_identifier' });
    return id;
  };

  return {
    verifyEvent(payload, signatureHeader) {
      const invalid = new AppError('unauthenticated', 'the payment event signature is not valid', { code: 'payments.signature_invalid' });
      let timestamp: number | undefined;
      const signatures: Buffer[] = [];
      for (const part of signatureHeader.split(',')) {
        const match = SIGNATURE_PART.exec(part.trim());
        if (match?.[1] === 't') timestamp = Number(match[2]);
        else if (match?.[1] === 'v1' && match[2]!.length === 64) signatures.push(Buffer.from(match[2]!, 'hex'));
      }
      if (timestamp === undefined || !Number.isSafeInteger(timestamp) || signatures.length === 0) throw invalid;
      if (Math.abs(Date.now() / 1000 - timestamp) > config.webhookToleranceSeconds) {
        throw new AppError('unauthenticated', 'the payment event is too old to accept', { code: 'payments.signature_stale' });
      }
      const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.${payload}`, 'utf8').digest();
      if (!signatures.some((signature) => timingSafeEqual(signature, expected))) throw invalid;

      let event: Json | undefined;
      try {
        event = asObject(JSON.parse(payload));
      } catch {
        event = undefined;
      }
      const id = asString(event?.['id']);
      const type = asString(event?.['type']);
      const object = asObject(asObject(event?.['data'])?.['object']);
      if (!id || !type || !object) throw new AppError('validation', 'the payment event is not readable', { code: 'payments.event_unreadable' });
      if (type.startsWith('customer.subscription.')) {
        const subscriptionId = asString(object['id']);
        if (!subscriptionId) throw unexpected('subscription event');
        return { id, kind: 'subscription', subscriptionId, metadata: metadataOf(object['metadata']) };
      }
      if (type.startsWith('invoice.')) return { id, kind: 'invoice', invoice: readInvoice(object) };
      return { id, kind: 'other' } satisfies PaymentEvent;
    },

    async createCustomer(input, idempotencyKey) {
      const customer = await request('POST', '/v1/customers', {
        name: input.name, metadata: { organisation_id: input.organisationId, cell_id: input.cellId },
      }, idempotencyKey);
      const id = asString(customer['id']);
      if (!id) throw unexpected('customer');
      return { id };
    },

    async customerMetadata(customerId) {
      return metadataOf((await request('GET', `/v1/customers/${segment(customerId)}`))['metadata']);
    },

    async createCheckout(input, idempotencyKey) {
      const metadata = { organisation_id: input.organisationId, cell_id: input.cellId };
      const session = await request('POST', '/v1/checkout/sessions', {
        mode: 'subscription', customer: input.customerId, client_reference_id: input.organisationId,
        line_items: [{ price: input.priceId, quantity: input.quantity }],
        success_url: input.successUrl, cancel_url: input.cancelUrl,
        // The subscription carries the tenant, so its webhooks need no lookup.
        subscription_data: { metadata }, metadata,
      }, idempotencyKey);
      const id = asString(session['id']);
      const url = asString(session['url']);
      if (!id || !url) throw unexpected('checkout session');
      return { id, url };
    },

    async getCheckout(id) {
      const session = await request('GET', `/v1/checkout/sessions/${segment(id)}`);
      const url = asString(session['url']);
      if (!url) throw unexpected('checkout session');
      return { id, url };
    },

    async createPortal(input) {
      const session = await request('POST', '/v1/billing_portal/sessions', { customer: input.customerId, return_url: input.returnUrl });
      const url = asString(session['url']);
      if (!url) throw unexpected('portal session');
      return { url };
    },

    async getSubscription(id) {
      return readSubscription(await request('GET', `/v1/subscriptions/${segment(id)}`));
    },

    async setSubscriptionQuantity(subscriptionId, quantity, prorate, idempotencyKey) {
      const current = await request('GET', `/v1/subscriptions/${segment(subscriptionId)}`);
      const itemId = asString(asObject((asObject(current['items'])?.['data'] as unknown[] | undefined)?.[0])?.['id']);
      if (!itemId) throw unexpected('subscription');
      return readSubscription(await request('POST', `/v1/subscriptions/${segment(subscriptionId)}`, {
        items: [{ id: itemId, quantity }], proration_behavior: prorate ? 'always_invoice' : 'none',
      }, idempotencyKey));
    },

    async chargeOnce(input, idempotencyKey): Promise<ChargeOutcome> {
      const currency = input.currency.toLowerCase();
      const invoice = await request('POST', '/v1/invoices', {
        customer: input.customerId, collection_method: 'charge_automatically', auto_advance: false,
        pending_invoice_items_behavior: 'exclude', currency, description: input.description, metadata: input.metadata,
      }, `${idempotencyKey}:invoice`);
      const invoiceId = asString(invoice['id']);
      if (!invoiceId) throw unexpected('invoice');
      await request('POST', '/v1/invoiceitems', {
        customer: input.customerId, invoice: invoiceId, amount: input.amountMinor, currency, description: input.description,
        metadata: input.metadata,
      }, `${idempotencyKey}:item`);
      await request('POST', `/v1/invoices/${segment(invoiceId)}/finalize`, { auto_advance: false }, `${idempotencyKey}:finalize`);
      try {
        const paid = await request('POST', `/v1/invoices/${segment(invoiceId)}/pay`, { off_session: true }, `${idempotencyKey}:pay`);
        return { invoiceId, outcome: paid['status'] === 'paid' ? 'paid' : 'declined' };
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'payments.card_declined') throw error;
        // An unpaid one-off invoice is voided, so it is never collected later by surprise.
        await request('POST', `/v1/invoices/${segment(invoiceId)}/void`, {}, `${idempotencyKey}:void`).catch(() => undefined);
        return { invoiceId, outcome: error.details['providerCode'] === 'authentication_required' ? 'requires_action' : 'declined' };
      }
    },

    async createContractInvoice(input, idempotencyKey) {
      const currency = input.currency.toLowerCase();
      const invoice = await request('POST', '/v1/invoices', {
        customer: input.customerId, collection_method: 'send_invoice', days_until_due: input.daysUntilDue, auto_advance: false,
        pending_invoice_items_behavior: 'exclude', currency, metadata: input.metadata,
        // Receiving and matching the purchase order is Silo's workflow; it rides on the invoice (74.5).
        ...(input.purchaseOrder === undefined ? {} : { custom_fields: [{ name: 'Purchase order', value: input.purchaseOrder }] }),
      }, `${idempotencyKey}:invoice`);
      const invoiceId = asString(invoice['id']);
      if (!invoiceId) throw unexpected('invoice');
      let n = 0;
      for (const line of input.lines) {
        await request('POST', '/v1/invoiceitems', {
          customer: input.customerId, invoice: invoiceId, amount: line.amountMinor, currency, description: line.description,
          period: { start: Math.floor(Date.parse(input.periodStart) / 1000), end: Math.floor(Date.parse(input.periodEnd) / 1000) },
          metadata: input.metadata,
        }, `${idempotencyKey}:item:${n}`);
        n += 1;
      }
      await request('POST', `/v1/invoices/${segment(invoiceId)}/finalize`, { auto_advance: false }, `${idempotencyKey}:finalize`);
      return readInvoice(await request('POST', `/v1/invoices/${segment(invoiceId)}/send`, {}, `${idempotencyKey}:send`));
    },

    async createUsageInvoice(input, idempotencyKey) {
      const currency = input.currency.toLowerCase();
      const automatic = input.collection.kind === 'automatic';
      const invoice = await request('POST', '/v1/invoices', {
        customer: input.customerId, currency, metadata: input.metadata, pending_invoice_items_behavior: 'exclude',
        ...(automatic ? { collection_method: 'charge_automatically', auto_advance: true }
          : { collection_method: 'send_invoice', days_until_due: (input.collection as { daysUntilDue: number }).daysUntilDue, auto_advance: false }),
        ...(input.purchaseOrder === undefined ? {} : { custom_fields: [{ name: 'Purchase order', value: input.purchaseOrder }] }),
      }, `${idempotencyKey}:invoice`);
      const invoiceId = asString(invoice['id']);
      if (!invoiceId) throw unexpected('invoice');
      let n = 0;
      for (const line of input.lines) {
        await request('POST', '/v1/invoiceitems', {
          customer: input.customerId, invoice: invoiceId, amount: line.amountMinor, currency, description: line.description,
          period: { start: Math.floor(Date.parse(input.periodStart) / 1000), end: Math.floor(Date.parse(input.periodEnd) / 1000) },
          metadata: input.metadata,
        }, `${idempotencyKey}:item:${n}`);
        n += 1;
      }
      // Charged automatically, the provider collects it on finalising; sent, it goes with its terms.
      const finalised = await request('POST', `/v1/invoices/${segment(invoiceId)}/finalize`, { auto_advance: automatic }, `${idempotencyKey}:finalize`);
      if (automatic) return readInvoice(finalised);
      return readInvoice(await request('POST', `/v1/invoices/${segment(invoiceId)}/send`, {}, `${idempotencyKey}:send`));
    },
  };
}
