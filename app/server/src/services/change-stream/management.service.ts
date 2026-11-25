// Managing a connection's change stream (spec 18.8, 18.10): stream.enable to enable, and
// stream.manage to pause, resume, disable and rotate, held by the connection's owner or
// decided by the policy service at the connection's owning scope.
//
// Enabling registers the inbound webhook endpoint where the manifest declares a webhook:
// a 256-bit path token (only its SHA-256 is stored; the token routes, it does not
// authenticate) and the signing secret, sealed by the credential service, either the
// provider's or one Silo generates. The path and a generated secret are shown once. An
// object whose only source is polling needs no registration and streams while held live.
//
// The status says, per object, whether it is subscribable and its mode (decision 2026-11-15).
// A polling fallback (stream.manage) lets an object that is not subscribable be polled every
// N minutes: it needs a declared poll source, an interval no shorter than the manifest's, and
// room in the connector's declared request rate, of which the connection's fallback polls may
// take a tenth (spec 18.4: polling shares the budget with queries, and backs off first).
//
// Change data capture (capture.contract.ts): setting it up records the slot the owner confirmed
// (stream.enable, cdc_slot_created); dropping it (stream.manage) asks an agent of the pool to
// drop the slot, recorded when it has (cdc.service). Sources are used in the order webhook,
// change data capture, polling (spec 18.1): capture while an agent of the pool reads it.

import { pollSourceOf } from './poller.service.ts';
import { subscribabilityOf } from './subscribability.service.ts';
import { sealWebhookSecret } from '../../contracts/credential/changeStream.contract.ts';
import { changeHookPath, type StreamStatusView } from '../../contracts/change-stream/stream.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { cdcTables } from '../../contracts/connect/manifest.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { cdcSlotRepo, emailAddressRepo, streamPollingFallbackRepo, webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import type { CdcSlot } from '../../models/connect/cdcSlot.model.ts';
import { randomBytes } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordStreamEvent, type ChangeStreamDeps } from './deps.service.ts';
import { tokenHash } from './intake.service.ts';
import { emailTokenHash } from './email.service.ts';
import type { ConnectionSources, SourceCatalogue } from './sources.service.ts';
import { isReading, type StreamHealthStore } from './status.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

/** The part of the connector's declared request rate a connection's fallback polls may take. */
const FALLBACK_SHARE = 0.1;

export function createStreamManagement(deps: ChangeStreamDeps, catalogue: SourceCatalogue, health: StreamHealthStore) {
  const control = deps.databases.pool('control');

  const member = (ctx: Context): string => {
    const membershipId = ctx.request.membershipId;
    if (membershipId === undefined) throw new AppError('forbidden', 'change streams are managed by a member', { code: 'stream.member_required' });
    return membershipId;
  };

  async function permitted(ctx: Context, sources: ConnectionSources, permission: 'stream.enable' | 'stream.manage'): Promise<void> {
    const { connection } = sources;
    if (connection.owningMembershipId === member(ctx)) return;
    const decision = await deps.services.call(authorise, {
      body: { permission, scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    if (decision.decision !== 'allow') {
      throw new AppError('forbidden', `you do not hold ${permission} on this connection`, { code: 'stream.not_permitted', details: { permission } });
    }
  }

  async function view(ctx: Context, sources: ConnectionSources): Promise<StreamStatusView> {
    const { connection } = sources;
    const { endpoint, modes, capture } = await inTransaction(control, ctx.request, async (db) => ({
      endpoint: await webhookEndpointRepo.liveInbound(db, connection.id),
      modes: await subscribabilityOf(db, connection, [...sources.streamed.keys()]),
      capture: await cdcSlotRepo.currentFor(db, connection.id),
    }), { readOnly: true });
    const record = await health.read(connection.organisationId, connection.id);
    const halted = connection.status === 'halted' || connection.status === 'revoked';
    const reading = capture !== undefined && isReading(capture);
    return {
      connectionId: connection.id,
      webhook: endpoint === undefined ? null : {
        status: endpoint.status, lastFour: endpoint.secretLastFour, lastDeliveryAt: endpoint.lastDeliveryAt,
        rejectedCount: Number(endpoint.rejectedCount), createdAt: endpoint.createdAt,
      },
      capture: capture === undefined || capture.status === 'dropped' ? null : {
        slotId: capture.id, method: capture.method, slotName: capture.slotName, publication: capture.publication, status: capture.status,
        reading, acknowledgedPosition: capture.acknowledgedPosition, acknowledgedAt: capture.acknowledgedAt, confirmedBy: capture.confirmedBy,
        createdAt: capture.createdAt,
        lastGap: record?.gapReason === undefined ? null : {
          reason: record.gapReason, changes: record.gapChanges ?? null, from: record.gapFrom ?? null, to: record.gapTo ?? null,
          reportedAt: record.gapAt ?? record.since,
        },
      },
      objects: [...sources.streamed.values()].map((s) => {
        const webhookUsable = s.kinds.includes('webhook') && endpoint?.status === 'active';
        const captured = s.kinds.includes('cdc') && reading;
        // MQTT telemetry (20.6) and OPC UA subscriptions (20.3) are read by the agent holding the capture, as change data capture is.
        const subscription = s.kinds.includes('mqtt') ? 'mqtt' as const : s.kinds.includes('opcua') ? 'opcua' as const : undefined;
        const subscribed = subscription !== undefined && reading;
        const pollable = s.kinds.includes('poll');
        const inUse = halted ? 'none' as const
          : webhookUsable && record?.status !== 'delayed' ? 'webhook' as const
            : captured ? 'cdc' as const : subscribed ? subscription : pollable ? 'poll' as const : webhookUsable ? 'webhook' as const : 'none' as const;
        // A capture set up that no agent reads, or lost, leaves the stream stale (spec 18.7), not merely unstreamed.
        const leased = s.kinds.includes('cdc') || subscription !== undefined;
        const lapsed = leased && (capture?.status === 'active' || capture?.status === 'lost');
        const status = halted ? 'stopped' as const : inUse === 'none' ? (lapsed ? 'stale' as const : 'not_streamed' as const) : record?.status ?? 'live';
        const reason = halted ? `connection ${connection.status}` : inUse === 'none'
          ? (leased
            ? captureReason(capture, record?.source === 'cdc' || record?.source === 'mqtt' || record?.source === 'opcua' ? record.reason : undefined)
            : 'no source is enabled')
          : record?.reason ?? null;
        const mode = modes.get(s.object.name)!;
        return {
          object: s.object.name, declared: s.kinds, inUse, status, lastDeltaAt: record?.lastDeltaAt ?? null, reason: reason ?? null,
          subscribable: mode.subscribable, mode: mode.mode, refreshEverySeconds: mode.mode === 'polled' ? mode.fallback!.intervalSeconds : null,
          conformanceRunId: mode.runId, failedTests: mode.failed,
        };
      }),
    };
  }

  async function sealed(ctx: Context, connectionId: string, secret: string | undefined) {
    return deps.services.call(sealWebhookSecret, { body: { connectionId, ...(secret === undefined ? {} : { secret }) } },
      { request: ctx.request, correlationId: ctx.correlationId });
  }

  return {
    async status(ctx: Context, connectionId: string): Promise<StreamStatusView> {
      const sources = await catalogue.load(ctx.request, connectionId);
      return view(ctx, sources);
    },

    /** Records the capture the owner confirmed, with the slot name they were shown; an agent of the pool makes the slot. */
    async setCapture(ctx: Context, connectionId: string, input: { slotName: string; publication?: string | undefined }): Promise<StreamStatusView> {
      const sources = await catalogue.load(ctx.request, connectionId);
      await permitted(ctx, sources, 'stream.enable');
      const { connection } = sources;
      if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection streams nothing', { code: 'connection.revoked' });
      // An MQTT or OPC UA subscription (20.6, 20.3) is set up as a capture is; an MQTT one's slot name is the client identifier the broker sees.
      const methods = new Set([...sources.streamed.values()].flatMap((s) => s.stream.sources.flatMap((source) =>
        (source.kind === 'cdc' ? [source.method] : source.kind === 'mqtt' || source.kind === 'opcua' ? [source.kind] : []))));
      if (methods.size === 0) throw new AppError('validation', 'the connector streams nothing by change data capture', { code: 'stream.cdc_not_declared' });
      if (methods.size > 1) throw new AppError('integrity', 'the connector declares more than one capture method', { code: 'stream.cdc_methods_mixed' });
      const method = [...methods][0]!;
      if (method === 'logical_replication' && input.publication === undefined) {
        throw new AppError('validation', 'logical replication reads a publication: name the one made for the captured tables', { code: 'stream.publication_required' });
      }
      if (method !== 'logical_replication' && input.publication !== undefined) {
        throw new AppError('validation', `a ${method} capture reads no publication`, { code: 'stream.publication_not_used', details: { method } });
      }
      if (method !== 'logical_replication' && method !== 'mqtt' && method !== 'opcua') {
        // A binary log carries every database of the server, and change tracking is read table by table: each names its schema.
        const unqualified = cdcTables(sources.manifest).filter((t) => t.schema === undefined).map((t) => t.object);
        if (unqualified.length > 0) {
          throw new AppError('validation', `a ${method} capture reads tables by schema: give each captured object's source its schema`, {
            code: 'stream.cdc_schema_required', details: { objects: unqualified.join(', ') },
          });
        }
      }
      const publication = input.publication ?? null;
      if (connection.agentPoolId === null) {
        throw new AppError('validation', 'change data capture is read by a Silo Agent: bind the connection to an agent pool', { code: 'stream.cdc_needs_agent' });
      }
      const organisationId = connection.organisationId;
      try {
        await inTransaction(control, ctx.request, async (db) => {
          const current = await cdcSlotRepo.currentFor(db, connectionId);
          if (current?.status === 'active') {
            throw new AppError('conflict', 'change data capture is set up already; drop it first', { code: 'stream.capture_exists' });
          }
          const id = uuidv7();
          await cdcSlotRepo.insert(db, {
            id, organisationId, connectionId, agentPoolId: connection.agentPoolId!, method, slotName: input.slotName, publication,
            confirmedBy: member(ctx),
          });
          await recordStreamEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'cdc_slot_created', membershipId: member(ctx), connectionId,
            detail: { slot_id: id, slot_name: input.slotName, publication, method, agent_pool_id: connection.agentPoolId },
          });
        });
      } catch (error) {
        if (isAppError(error) && error.details['sqlstate'] === '23505') {
          throw new AppError('conflict', 'that slot name is still in use on this connection: choose another', { code: 'stream.slot_name_in_use' });
        }
        throw error;
      }
      return view(ctx, sources);
    },

    /** Asks an agent of the pool to drop the slot; the stream stops capturing at once. */
    async dropCapture(ctx: Context, connectionId: string): Promise<StreamStatusView> {
      const sources = await catalogue.load(ctx.request, connectionId);
      await permitted(ctx, sources, 'stream.manage');
      await inTransaction(control, ctx.request, async (db) => {
        const current = await cdcSlotRepo.currentFor(db, connectionId);
        if (current === undefined) throw new AppError('conflict', 'change data capture is not set up', { code: 'stream.capture_not_set_up' });
        if (current.status === 'dropping') return;
        await cdcSlotRepo.update(db, current.id, { status: 'dropping', droppedBy: member(ctx) });
      });
      return view(ctx, sources);
    },

    async enable(ctx: Context, connectionId: string, secret: string | undefined) {
      const sources = await catalogue.load(ctx.request, connectionId);
      await permitted(ctx, sources, 'stream.enable');
      const { connection, manifest } = sources;
      if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection streams nothing', { code: 'connection.revoked' });
      if (sources.streamed.size === 0) throw new AppError('validation', 'the connector declares no change stream', { code: 'stream.not_declared' });
      const organisationId = connection.organisationId;
      let webhook: { path: string; secret?: string } | undefined;
      let email: { address: string } | undefined;
      if (manifest.changeStream?.email !== undefined) {
        // Email fallback (spec 14.4): an address minted for the connection; its token routes the relay's posts.
        if (deps.inboundEmail === undefined) {
          throw new AppError('configuration', 'this cell takes no email: INBOUND_EMAIL_DOMAIN and INBOUND_EMAIL_SECRET are not set', { code: 'config.inbound_email' });
        }
        const existing = await inTransaction(control, ctx.request, (db) => emailAddressRepo.liveFor(db, connection.id), { readOnly: true });
        if (existing !== undefined) throw new AppError('conflict', 'the stream is already enabled; disable it to mint another address', { code: 'stream.already_enabled' });
        const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
        const token = [...randomBytes(26)].map((b) => alphabet[b % 32]).join('');
        await inTransaction(control, ctx.request, async (db) => {
          const id = uuidv7();
          await emailAddressRepo.insert(db, { id, organisationId, connectionId: connection.id, tokenHash: emailTokenHash(token), createdBy: member(ctx) });
          if (manifest.changeStream?.webhook === undefined) {
            await recordStreamEvent(db, {
              organisationId, correlationId: ctx.correlationId, event: 'stream_enabled', membershipId: member(ctx), connectionId: connection.id,
              detail: { objects: sources.streamed.size, email_address_id: id },
            });
          }
        });
        email = { address: `c-${token}@${deps.inboundEmail.domain}` };
      }
      if (manifest.changeStream?.webhook !== undefined) {
        const existing = await inTransaction(control, ctx.request, (db) => webhookEndpointRepo.liveInbound(db, connection.id), { readOnly: true });
        if (existing !== undefined) throw new AppError('conflict', 'the stream is already enabled; rotate the secret or disable it', { code: 'stream.already_enabled' });
        const credential = await sealed(ctx, connection.id, secret);
        const token = randomBytes(32).toString('base64url');
        await inTransaction(control, ctx.request, async (db) => {
          const id = uuidv7();
          await webhookEndpointRepo.insert(db, {
            id, organisationId, connectionId: connection.id, direction: 'inbound', pathTokenHash: tokenHash(token),
            secretCredentialId: credential.credentialId, createdBy: member(ctx),
          });
          await recordStreamEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'webhook_registered', membershipId: member(ctx), connectionId: connection.id,
            detail: { endpoint_id: id, generated_secret: credential.generated !== undefined },
          });
          await recordStreamEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'stream_enabled', membershipId: member(ctx), connectionId: connection.id,
            detail: { objects: sources.streamed.size },
          });
        });
        webhook = { path: changeHookPath(organisationId, token), ...(credential.generated === undefined ? {} : { secret: credential.generated }) };
      } else if (email === undefined) {
        await inTransaction(control, ctx.request, (db) => recordStreamEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'stream_enabled', membershipId: member(ctx), connectionId: connection.id,
          detail: { objects: sources.streamed.size },
        }));
      }
      return { stream: await view(ctx, sources), ...(webhook === undefined ? {} : { webhook }), ...(email === undefined ? {} : { email }) };
    },

    async move(ctx: Context, connectionId: string, to: 'disable' | 'pause' | 'resume'): Promise<StreamStatusView> {
      const sources = await catalogue.load(ctx.request, connectionId);
      await permitted(ctx, sources, 'stream.manage');
      const organisationId = sources.connection.organisationId;
      await inTransaction(control, ctx.request, async (db) => {
        const endpoint = await webhookEndpointRepo.liveInbound(db, connectionId);
        const address = await emailAddressRepo.liveFor(db, connectionId);
        if (endpoint === undefined && address !== undefined) {
          // An email address is taken or revoked: nothing is paused at a mail relay.
          if (to !== 'disable') throw new AppError('conflict', 'an email stream is enabled or disabled, not paused', { code: 'stream.email_not_pausable' });
          await emailAddressRepo.update(db, address.id, { status: 'revoked', revokedAt: new Date().toISOString() });
          await recordStreamEvent(db, {
            organisationId, correlationId: ctx.correlationId, membershipId: member(ctx), connectionId, event: 'stream_disabled', detail: { email_address_id: address.id },
          });
          return;
        }
        if (endpoint === undefined) throw new AppError('conflict', 'the stream has no webhook endpoint to change', { code: 'stream.not_enabled' });
        if (to === 'disable' && address !== undefined) await emailAddressRepo.update(db, address.id, { status: 'revoked', revokedAt: new Date().toISOString() });
        if (to === 'disable') await webhookEndpointRepo.revokeInbound(db, connectionId);
        else {
          const next = to === 'pause' ? 'paused' : 'active';
          if (endpoint.status === next) return;
          await webhookEndpointRepo.update(db, endpoint.id, { status: next });
        }
        await recordStreamEvent(db, {
          organisationId, correlationId: ctx.correlationId, membershipId: member(ctx), connectionId,
          event: to === 'disable' ? 'stream_disabled' : to === 'pause' ? 'stream_paused' : 'stream_resumed', detail: { endpoint_id: endpoint.id },
        });
      });
      return view(ctx, sources);
    },

    async setFallback(ctx: Context, connectionId: string, object: string, input: { enabled: boolean; intervalMinutes?: number | undefined }) {
      const sources = await catalogue.load(ctx.request, connectionId);
      await permitted(ctx, sources, 'stream.manage');
      const { connection, manifest } = sources;
      const organisationId = connection.organisationId;
      const streamed = sources.streamed.get(object);
      if (streamed === undefined) throw new AppError('validation', `the connector does not stream ${object}`, { code: 'stream.not_declared' });
      await inTransaction(control, ctx.request, async (db) => {
        const active = await streamPollingFallbackRepo.activeFor(db, connectionId);
        const current = active.find((f) => f.object === object);
        if (!input.enabled) {
          if (current === undefined) return;
          await streamPollingFallbackRepo.update(db, current.id, { disabledBy: member(ctx), disabledAt: new Date().toISOString() });
          await recordStreamEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'polling_fallback_disabled', membershipId: member(ctx), connectionId,
            detail: { object, interval_seconds: current.intervalSeconds },
          });
          return;
        }
        const poll = pollSourceOf(streamed);
        if (poll === undefined) {
          throw new AppError('validation', `${object} declares no poll source: there is no watermark to poll from`, { code: 'stream.no_watermark' });
        }
        const mode = (await subscribabilityOf(db, connection, [object])).get(object)!;
        if (mode.subscribable) throw new AppError('conflict', `${object} is subscribable: it streams live`, { code: 'stream.subscribable' });
        const intervalSeconds = input.intervalMinutes! * 60;
        if (intervalSeconds < poll.intervalSeconds) {
          throw new AppError('validation', `the connector polls ${object} no more often than every ${Math.ceil(poll.intervalSeconds / 60)} minutes`, {
            code: 'stream.interval_too_short', details: { minimumMinutes: Math.ceil(poll.intervalSeconds / 60) },
          });
        }
        const perSecond = manifest.limits.requestsPerSecond;
        if (perSecond !== undefined) {
          const others = active.filter((f) => f.object !== object).reduce((n, f) => n + 60 / f.intervalSeconds, 0);
          const needed = others + 60 / intervalSeconds;
          const budget = perSecond * 60 * FALLBACK_SHARE;
          if (needed > budget) {
            throw new AppError('conflict', 'the connector\'s rate limit leaves no room to poll this often: choose a longer interval', {
              code: 'stream.rate_limit_insufficient', details: { pollsPerMinute: Math.round(needed * 1000) / 1000, budgetPerMinute: Math.round(budget * 1000) / 1000 },
            });
          }
        }
        if (current !== undefined) {
          if (current.intervalSeconds === intervalSeconds) return;
          await streamPollingFallbackRepo.update(db, current.id, { disabledBy: member(ctx), disabledAt: new Date().toISOString() });
        }
        await streamPollingFallbackRepo.insert(db, {
          id: uuidv7(), organisationId, connectionId, object, intervalSeconds, enabledBy: member(ctx),
        });
        await recordStreamEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'polling_fallback_enabled', membershipId: member(ctx), connectionId,
          detail: { object, interval_seconds: intervalSeconds, replaced: current !== undefined },
        });
      });
      return view(ctx, sources);
    },

    async rotate(ctx: Context, connectionId: string, secret: string | undefined) {
      const sources = await catalogue.load(ctx.request, connectionId);
      await permitted(ctx, sources, 'stream.manage');
      const organisationId = sources.connection.organisationId;
      const endpoint = await inTransaction(control, ctx.request, (db) => webhookEndpointRepo.liveInbound(db, connectionId), { readOnly: true });
      if (endpoint === undefined) throw new AppError('conflict', 'the stream has no webhook endpoint', { code: 'stream.not_enabled' });
      const credential = await sealed(ctx, connectionId, secret);
      await inTransaction(control, ctx.request, async (db) => {
        await webhookEndpointRepo.update(db, endpoint.id, { secretCredentialId: credential.credentialId });
        await recordStreamEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'webhook_secret_rotated', membershipId: member(ctx), connectionId,
          detail: { endpoint_id: endpoint.id, generated_secret: credential.generated !== undefined },
        });
      });
      return { lastFour: credential.lastFour, ...(credential.generated === undefined ? {} : { secret: credential.generated }) };
    },
  };
}

export type StreamManagement = ReturnType<typeof createStreamManagement>;

function captureReason(capture: CdcSlot | undefined, failure: string | undefined): string {
  if (capture === undefined || capture.status === 'dropped') return 'change data capture is not set up';
  if (capture.status === 'lost') return 'the replication slot was lost on the source: set up change capture again';
  if (capture.status === 'dropping') return 'change data capture is being dropped';
  return failure ?? 'no Silo Agent of the connection\'s pool is reading the change capture';
}
