// Outbound webhook delivery (spec 20.4, 42.6): an Action's webhook side effect, queued by
// actions in action.webhook_deliveries when the Action executed, posted here.
//
// Each due delivery is posted to its target through the egress (HTTPS, public addresses
// only), as JSON, with the Action execution's identifier as the idempotency key and an
// HMAC-SHA256 signature over the timestamp and body that the credential service computes
// under the target's secret. A 2xx delivers it, and the receipt meant delivery, not effect.
// Once a delivery ends, delivered or failed, its sealed payload is cleared: record values do
// not outlive their use (65.3).
//
// A target on a connection reached through the Silo Agent (20.4) is posted by the agent, inside
// the customer's network: each attempt asks actions for an execution grant over the request's
// hash, and connect-runtime and the agent check it (10.4). A target declaring a status
// endpoint has its effect read after delivery, GET with the delivery id and signed the same
// way: applied or failed ends it (failed is outbound_webhook_failed, effect_failed); pending,
// or no answer, is asked again with the same backoff until 24 hours after delivery, then the
// effect is unconfirmed.
// Anything else is retried with exponential backoff (30 seconds doubling, at most an hour
// apart) for 24 hours from the Action; then the delivery fails for good. A paused or revoked
// target's deliveries wait or fail. The audit log records each delivery and each failure; the
// remote's text is never kept.
//
// A physical target's delivery (47.4) carries the allow-list entry it was queued under: before
// each attempt the entry must still be live, or the delivery fails, never sent (not_listed).
// Through the agent the request names the action, and the agent checks its own signed list, the
// entry's interval and the connection's rate; its refusal is final, never retried, and raises
// physical_write_refused_by_agent, which must never happen in normal operation.

import { createHash } from 'node:crypto';
import { signWebhookGrant } from '../../contracts/actions/grant.contract.ts';
import { sendWebhookThroughAgent, type AgentWebhookRequest } from '../../contracts/connect-runtime/agentWebhook.contract.ts';
import { signOutboundWebhook } from '../../contracts/credential/outboundWebhookSecret.contract.ts';
import { openRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import type { Egress } from '../../infra/egress.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { actuationAllowlistRepo, webhookDeliveryRepo } from '../../repos/action/index.repo.ts';
import { connectionRepo, webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { recordActionEvent } from '../actions/events.service.ts';
import { DELIVERY } from './actionEvents.service.ts';

export interface WebhookDeliveryDeps {
  databases: Databases;
  services: ServiceClient;
  egress: Egress;
  logger: Logger;
}

const backoff = (attempts: number): number => Math.min(DELIVERY.baseDelayMs * 2 ** Math.max(0, attempts - 1), DELIVERY.maxDelayMs);

export function createWebhookDelivery(deps: WebhookDeliveryDeps) {
  const control = deps.databases.pool('control');

  /** A POST sent by the connection's agent, on a grant over the request as the agent receives it; a GET without one. */
  async function throughAgent(request: { organisationId: string }, correlationId: string, deliveryId: string, endpointId: string, http: AgentWebhookRequest)
    : Promise<{ status: number; state: 'applied' | 'pending' | 'failed' | null }> {
    const grant = http.method === 'POST' ? await deps.services.call(signWebhookGrant, {
      params: { deliveryId }, body: { payloadSha256: createHash('sha256').update(JSON.stringify([http]), 'utf8').digest('hex') },
    }, { request, correlationId }) : undefined;
    return deps.services.call(sendWebhookThroughAgent, { params: { endpointId }, body: { request: http, ...(grant === undefined ? {} : { grant }) } }, { request, correlationId });
  }

  /** One delivered webhook's effect, asked of its status endpoint. */
  async function checkOne(organisationId: string, deliveryId: string, correlationId: string, now: Date): Promise<'applied' | 'failed' | 'pending' | 'unconfirmed' | 'skipped'> {
    const request = { organisationId };
    const loaded = await inTransaction(control, request, async (db) => {
      const delivery = await webhookDeliveryRepo.findById(db, deliveryId);
      const endpoint = delivery === undefined ? undefined : await webhookEndpointRepo.findById(db, delivery.endpointId);
      return { delivery, endpoint, connection: endpoint === undefined ? undefined : await connectionRepo.findById(db, endpoint.connectionId) };
    }, { readOnly: true });
    const { delivery, endpoint, connection } = loaded;
    if (delivery === undefined || endpoint === undefined || delivery.effect !== 'pending' || endpoint.statusUrl === null) return 'skipped';
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const url = new URL(endpoint.statusUrl);
    url.searchParams.set('delivery', delivery.id);
    let state: 'applied' | 'pending' | 'failed' | null = null;
    try {
      const { signature } = await deps.services.call(signOutboundWebhook, { body: { credentialId: endpoint.secretCredentialId, timestamp, body: delivery.id } },
        { request, correlationId });
      const headers = { 'user-agent': 'Silo-Webhooks/1', 'idempotency-key': delivery.executionKey, 'silo-delivery-id': delivery.id, 'silo-timestamp': timestamp, 'silo-signature': signature };
      if ((connection?.agentPoolId ?? null) !== null) {
        const reply = await throughAgent(request, correlationId, delivery.id, endpoint.id, { method: 'GET', url: url.toString(), headers, body: '' });
        state = reply.status >= 200 && reply.status <= 299 ? reply.state : null;
      } else {
        const reply = await deps.egress.send({ url, method: 'GET', timeoutMs: DELIVERY.timeoutMs, headers });
        if (reply.status >= 200 && reply.status <= 299 && reply.body.length <= 4_096) {
          const said = (JSON.parse(reply.body.toString('utf8')) as { state?: unknown }).state;
          state = said === 'applied' || said === 'pending' || said === 'failed' ? said : null;
        }
      }
    } catch {
      state = null;
    }
    const at = now.toISOString();
    const effectAttempts = delivery.effectAttempts + 1;
    const event = { organisationId, correlationId, request, service: 'notify' as const, resource: { type: 'mutation' as const, id: delivery.mutationId } };
    if (state === 'applied' || state === 'failed') {
      await inTransaction(control, request, async (db) => {
        await webhookDeliveryRepo.update(db, delivery.id, { effect: state, effectAttempts, effectCheckedAt: at, nextEffectCheckAt: null });
        if (state === 'failed') {
          await recordActionEvent(db, { ...event, event: 'outbound_webhook_failed', detail: { endpoint_id: endpoint.id, attempts: delivery.attempts, reason: 'effect_failed' } });
        }
      });
      return state;
    }
    if (now.getTime() - Date.parse(delivery.deliveredAt!) < DELIVERY.windowMs) {
      await inTransaction(control, request, (db) => webhookDeliveryRepo.update(db, delivery.id, {
        effectAttempts, effectCheckedAt: at, nextEffectCheckAt: new Date(now.getTime() + backoff(effectAttempts)).toISOString(),
      }));
      return 'pending';
    }
    await inTransaction(control, request, (db) => webhookDeliveryRepo.update(db, delivery.id, { effect: 'unconfirmed', effectAttempts, effectCheckedAt: at, nextEffectCheckAt: null }));
    return 'unconfirmed';
  }

  async function deliverOne(organisationId: string, deliveryId: string, correlationId: string, now: Date): Promise<'delivered' | 'retry' | 'failed' | 'skipped'> {
    const request = { organisationId };
    const loaded = await inTransaction(control, request, async (db) => {
      const delivery = await webhookDeliveryRepo.findById(db, deliveryId);
      const endpoint = delivery === undefined ? undefined : await webhookEndpointRepo.findById(db, delivery.endpointId);
      const entry = delivery?.allowlistEntryId == null ? undefined : await actuationAllowlistRepo.findById(db, delivery.allowlistEntryId);
      return delivery === undefined ? undefined : {
        delivery, endpoint, entry, connection: endpoint === undefined ? undefined : await connectionRepo.findById(db, endpoint.connectionId),
      };
    }, { readOnly: true });
    if (loaded === undefined || loaded.delivery.status !== 'pending' || loaded.delivery.payload === null || loaded.endpoint === undefined) return 'skipped';
    const { delivery, endpoint } = loaded;
    const viaAgent = (loaded.connection?.agentPoolId ?? null) !== null;
    if (endpoint.status === 'paused') return 'skipped';
    // The payload is sealed to its row (it may carry the Action's values): opened only to be sent, never kept or logged.
    const opened = await deps.services.call(openRecordValues, {
      body: { items: [{ binding: { table: 'action.webhook_deliveries', id: delivery.id, column: 'payload' }, sealed: delivery.payload!.toString('base64') }] },
    }, { request, correlationId });
    const body = JSON.stringify((JSON.parse(Buffer.from(opened.items[0]!, 'base64').toString('utf8')) as { v: unknown }).v);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    let status: number | null = null;
    let agentReason: string | null = null;
    let error: string | null = endpoint.status === 'revoked' ? 'endpoint_revoked' : null;
    // A physical target (47.4): sent only while the entry it was queued under is listed.
    const physical = delivery.allowlistEntryId === null ? undefined : loaded.entry !== undefined && loaded.entry.removedAt === null
      ? { action: loaded.entry.nodeAddress, maxPerMinute: loaded.connection?.maxPhysicalWritesPerMinute ?? 0 } : null;
    if (error === null && physical === null) error = 'actuation.not_listed';
    if (error === null) {
      try {
        const { signature } = await deps.services.call(signOutboundWebhook, { body: { credentialId: endpoint.secretCredentialId, timestamp, body } },
          { request, correlationId });
        const headers = {
          'content-type': 'application/json', 'user-agent': 'Silo-Webhooks/1', 'idempotency-key': delivery.executionKey,
          'silo-delivery-id': delivery.id, 'silo-timestamp': timestamp, 'silo-signature': signature,
        };
        const reply = viaAgent
          ? await throughAgent(request, correlationId, delivery.id, endpoint.id, { method: 'POST', url: endpoint.targetUrl!, headers, body, ...(physical ? { physical } : {}) })
          : await deps.egress.send({ url: new URL(endpoint.targetUrl!), method: 'POST', body, timeoutMs: DELIVERY.timeoutMs, headers });
        status = reply.status;
        if (reply.status < 200 || reply.status > 299) error = `http_${reply.status}`;
      } catch (failure) {
        error = isAppError(failure) ? failure.code.slice(0, 200) : 'delivery.failed';
        if (isAppError(failure) && typeof failure.details['reason'] === 'string') agentReason = failure.details['reason'];
      }
    }
    const at = now.toISOString();
    const attempts = delivery.attempts + 1;
    const event = { organisationId, correlationId, request, service: 'notify' as const, resource: { type: 'mutation' as const, id: delivery.mutationId } };
    if (error === null) {
      await inTransaction(control, request, async (db) => {
        await webhookDeliveryRepo.update(db, delivery.id, {
          status: 'delivered', attempts, lastStatus: status, lastError: null, deliveredAt: at, payload: null, payloadClearedAt: at,
          // A declared status endpoint: its effect is read next.
          ...(endpoint.statusUrl === null ? {} : { effect: 'pending', effectAttempts: 0, nextEffectCheckAt: new Date(now.getTime() + DELIVERY.baseDelayMs).toISOString() }),
        });
        await webhookEndpointRepo.update(db, endpoint.id, { lastDeliveryAt: at });
        await recordActionEvent(db, { ...event, event: 'outbound_webhook_delivered', detail: { endpoint_id: endpoint.id, attempts } });
      });
      return 'delivered';
    }
    // An allow-list refusal is the outcome, never retried (47.4).
    const refused = error === 'actuation.not_listed' || error === 'actuation.refused_by_agent';
    if (!refused && endpoint.status !== 'revoked' && now.getTime() - Date.parse(delivery.createdAt) < DELIVERY.windowMs) {
      await inTransaction(control, request, (db) => webhookDeliveryRepo.update(db, delivery.id, {
        attempts, lastStatus: status, lastError: error, nextAttemptAt: new Date(now.getTime() + backoff(attempts)).toISOString(),
      }));
      return 'retry';
    }
    if (error === 'actuation.refused_by_agent') {
      // The cell passed it; the agent's signed list did not. Never in normal operation.
      deps.logger.error('a physical webhook passed the cell but the agent refused it', {
        event: 'actuation.refused_by_agent', organisationId, resourceId: delivery.mutationId, reason: agentReason ?? 'unknown',
      });
    }
    await inTransaction(control, request, async (db) => {
      await webhookDeliveryRepo.update(db, delivery.id, { status: 'failed', attempts, lastStatus: status, lastError: error, failedAt: at, payload: null, payloadClearedAt: at });
      await recordActionEvent(db, { ...event, event: 'outbound_webhook_failed', detail: { endpoint_id: endpoint.id, attempts, reason: error } });
      if (error === 'actuation.refused_by_agent') {
        await recordActionEvent(db, {
          ...event, event: 'physical_write_refused_by_agent', detail: { connection_id: endpoint.connectionId, reason: agentReason, nodes: 1, endpoint_id: endpoint.id },
        });
      }
    });
    return 'failed';
  }

  return {
    /** The deliveries due now, across organisations, each under its own organisation. */
    /** Delivered webhooks whose effect is due to be asked, across organisations. */
    async checkEffectsDue(correlationId: string, now: Date = new Date()): Promise<{ applied: number; failed: number; pending: number; unconfirmed: number }> {
      const due = await inTransaction(control, {}, (db) => webhookDeliveryRepo.effectsDue(db, now.toISOString(), DELIVERY.batch), { readOnly: true });
      const out = { applied: 0, failed: 0, pending: 0, unconfirmed: 0 };
      for (const d of due) {
        try {
          const outcome = await checkOne(d.organisationId, d.id, correlationId, now);
          if (outcome !== 'skipped') out[outcome] += 1;
        } catch (error) {
          deps.logger.failure('a webhook effect could not be recorded; it is asked again', error, { event: 'notify.webhook_effect_failed', organisationId: d.organisationId });
        }
      }
      return out;
    },

    async deliverDue(correlationId: string, now: Date = new Date()): Promise<{ delivered: number; retried: number; failed: number }> {
      const due = await inTransaction(control, {}, (db) => webhookDeliveryRepo.due(db, now.toISOString(), DELIVERY.batch), { readOnly: true });
      const out = { delivered: 0, retried: 0, failed: 0 };
      for (const d of due) {
        try {
          const outcome = await deliverOne(d.organisationId, d.id, correlationId, now);
          if (outcome === 'delivered') out.delivered += 1;
          else if (outcome === 'retry') out.retried += 1;
          else if (outcome === 'failed') out.failed += 1;
        } catch (error) {
          deps.logger.failure('a webhook delivery could not be recorded; it is tried again', error, { event: 'notify.webhook_failed', organisationId: d.organisationId });
        }
      }
      return out;
    },
  };
}

export type WebhookDelivery = ReturnType<typeof createWebhookDelivery>;
