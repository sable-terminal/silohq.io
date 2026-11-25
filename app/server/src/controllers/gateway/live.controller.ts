// The live WebSocket (spec 30.3): one per page, at /api/v1/live.
//
// The handshake is admitted like a request (an Origin of this site, the address rate
// limit, the session cookie resolved as the person's activity, MFA complete, the session
// rate limit, at most GATEWAY_SOCKETS_PER_SESSION on the pod); a refusal answers the
// upgrade with the HTTP error body and no socket.
//
// On the socket:
// - every client message is a text frame validated by Zod; anything else closes it;
// - subscribe and unsubscribe are the person's doing: the session is resolved again as
//   activity (moving the idle clock, catching a revocation at once), and subscribe is
//   authorised for clone.view by the policy service before the state plane is asked;
// - ack, resync_required and heartbeat are the client's own traffic, and deltas and
//   heartbeats from the server are not activity (utils/session.util). Every
//   GATEWAY_SESSION_CHECK_SECONDS the session is checked without moving the idle clock;
//   a session that has ended closes its sockets (4401), and one that cannot be checked
//   for revocationCloseSeconds closes them too (4503), so revocation always lands;
// - a heartbeat every GATEWAY_HEARTBEAT_SECONDS; a client silent for two of them and a
//   grace is gone (4408);
// - at most GATEWAY_CLIENT_MESSAGES_PER_SECOND messages, and LIMITS.bus
//   .subscriptionsPerSession subscriptions per session on the pod.
// Values reach the socket and nowhere else: frames are never logged (spec 30.7).

import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Config } from '../../config/index.config.ts';
import { LIMITS } from '../../config/limits.config.ts';
import { CORRELATION_HEADER } from '../../contracts/endpoint.contract.ts';
import {
  clientMessage, LIVE_CLOSE, LIVE_PATH, serverFrame, type ClientMessage, type ServerFrame,
} from '../../contracts/gateway/live.contract.ts';
import type { EdgeSession } from '../../contracts/gateway/publicRoute.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { sessionTokenOf } from '../../middleware/cookies.middleware.ts';
import { checkWebSocketOrigin } from '../../middleware/crossSite.middleware.ts';
import { contextFor, requireComplete, resolveEdgeSession, sessionRequired } from '../../services/gateway/forwarding.service.ts';
import type { LiveHub, Claim } from '../../services/gateway/liveHub.service.ts';
import { createLiveSubscriber, type LiveSubscriber } from '../../services/gateway/liveSubscriber.service.ts';
import { publicError } from '../../middleware/errors.middleware.ts';
import type { EdgeLimiter } from '../../middleware/rateLimit.middleware.ts';
import { createSessionChecks } from '../../services/gateway/sessionChecks.service.ts';
import type { LiveHolder, SubscriptionSource } from '../../services/gateway/subscriptionSource.service.ts';
import { base64url, randomBytes } from '../../utils/crypto.util.ts';
import { AppError, isAppError, refuse } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { edgeClientOf } from '../../middleware/clientAddress.middleware.ts';

/** A socket whose send buffer passes this is not reading; it is closed. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;

export interface LiveDeps {
  config: Config;
  publicOrigin: string;
  logger: Logger;
  services: ServiceClient;
  limiter: EdgeLimiter;
  hub: LiveHub;
  source: SubscriptionSource;
  /** The coalescing window; LIMITS.statePlane.coalesceMs unless a test shortens it. */
  coalesceMs?: number;
}

export interface LiveEndpoint {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Refuses new sockets and closes open ones as going away; clients reconnect with backoff (spec 30.6). */
  close(): Promise<void>;
  readonly openSockets: number;
}

interface Held {
  subscriber: LiveSubscriber;
  claim: Claim;
  groupId: string;
}

const textOf = (data: RawData): string =>
  (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8');

export function createLiveEndpoint(deps: LiveDeps): LiveEndpoint {
  const { config, services, limiter, hub, source } = deps;
  const live = config.gateway.live;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, clientTracking: false });
  const sessionChecks = createSessionChecks(services, (live.sessionCheckSeconds * 1000) / 2);
  const sockets = new Set<WebSocket>();
  const socketsBySession = new Map<string, number>();
  const subscriptionsBySession = new Map<string, number>();
  let closing = false;

  const bump = (counts: Map<string, number>, key: string, by: number): void => {
    const next = (counts.get(key) ?? 0) + by;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  };

  const refuseUpgrade = (socket: Duplex, error: unknown, correlationId: string): void => {
    const { status, body, retryAfterSeconds } = publicError(error);
    const json = JSON.stringify(body);
    const headers = [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`, 'content-type: application/json', `content-length: ${Buffer.byteLength(json)}`,
      'cache-control: no-store', `${CORRELATION_HEADER}: ${correlationId}`, 'connection: close',
      ...(retryAfterSeconds === undefined ? [] : [`retry-after: ${retryAfterSeconds}`]),
    ];
    if (socket.writable) socket.end(`${headers.join('\r\n')}\r\n\r\n${json}`);
    else socket.destroy();
  };

  function connect(ws: WebSocket, session: EdgeSession, correlationId: string): void {
    const log = deps.logger.child({
      correlationId, route: 'gateway.live', organisationId: session.organisationId, membershipId: session.membershipId, sessionId: session.sessionId,
    });
    const holder: LiveHolder = {
      organisationId: session.organisationId, membershipId: session.membershipId, userId: session.userId, sessionId: session.sessionId,
    };
    const held = new Map<string, Held>();
    let lastHeard = Date.now();
    let lastVerified = Date.now();
    let window = { started: Date.now(), count: 0 };
    let queue = Promise.resolve();
    let releaseWatch: (() => void) | undefined;
    let ended = false;
    // The organisation's frames, from before the first subscription is asked for.
    const watching = hub.watch(session.organisationId);

    sockets.add(ws);
    bump(socketsBySession, session.sessionId, 1);
    log.info('live socket opened', { event: 'live.opened' });

    const send = (frame: ServerFrame): number => {
      if (ws.readyState !== WebSocket.OPEN) return 0;
      const checked = serverFrame.safeParse(frame);
      if (!checked.success) {
        log.error('a live frame did not match its contract', { event: 'contract.response_invalid', count: checked.error.issues.length });
        return 0;
      }
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        close(LIVE_CLOSE.clientTooSlow, 'client too slow');
        return 0;
      }
      const text = JSON.stringify(checked.data);
      ws.send(text);
      return Buffer.byteLength(text);
    };

    function close(code: number, reason: string): void {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        log.info('live socket closing', { event: 'live.closing', reason, status: code });
        ws.close(code, reason);
        setTimeout(() => ws.terminate(), 5_000).unref();
      }
    }

    const drop = (subscriptionId: string): void => {
      const entry = held.get(subscriptionId);
      if (entry === undefined) return;
      held.delete(subscriptionId);
      entry.claim.release();
      entry.subscriber.close();
      bump(subscriptionsBySession, session.sessionId, -1);
      void source.unsubscribe(holder, subscriptionId).catch((error: unknown) => {
        log.failure('the state plane did not take an unsubscribe', error, { event: 'live.unsubscribe_failed', subscriptionId });
      });
    };

    const end = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      for (const subscriptionId of [...held.keys()]) drop(subscriptionId);
      releaseWatch?.();
      sockets.delete(ws);
      bump(socketsBySession, session.sessionId, -1);
      log.info('live socket closed', { event: 'live.closed' });
    };

    const subscribe = async (message: Extract<ClientMessage, { type: 'subscribe' }>): Promise<void> => {
      const refused = (reason: 'bound' | 'unresolvable' | 'permission' | 'unavailable' | 'not_subscribable',
        extra: { bound?: string; limit?: number; count?: number } = {}) =>
        send({ type: 'refused', ref: message.ref, reason, ...extra });
      const count = subscriptionsBySession.get(session.sessionId) ?? 0;
      if (count >= LIMITS.bus.subscriptionsPerSession) {
        refused('bound', { bound: 'subscriptions_per_session', limit: LIMITS.bus.subscriptionsPerSession, count });
        return;
      }
      const decision = await services.call(authorise, { body: { permission: 'clone.view' } }, {
        request: contextFor(authorise, session), correlationId: uuidv7(),
      });
      if (decision.decision !== 'allow') {
        refused('permission');
        return;
      }

      await watching;
      const subscriptionId = `s_${base64url(randomBytes(12))}`;
      const subscriber = createLiveSubscriber({
        subscriptionId, send, bufferCapacity: message.bufferCapacity,
        onStalled: () => close(LIVE_CLOSE.clientTooSlow, 'client not acknowledging'),
        onModeChange: (mode) => {
          void source.bufferMode?.(holder, subscriptionId, mode).catch((error: unknown) =>
            log.failure('a subscriber\'s buffer mode was not reported', error, { event: 'live.buffer_mode_unreported' }));
        },
        ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
      });
      const claim = hub.claim(session.organisationId, subscriber);
      bump(subscriptionsBySession, session.sessionId, 1);
      const abandon = (): void => {
        claim.release();
        subscriber.close();
        bump(subscriptionsBySession, session.sessionId, -1);
      };
      let outcome;
      try {
        outcome = await source.subscribe(holder, {
          subscriptionId, set: message.set, properties: message.properties, lastSeq: message.lastSeq,
        }, { correlationId: uuidv7() });
      } catch (error) {
        abandon();
        log.failure('the state plane did not take a subscription', error, { event: 'live.subscribe_failed' });
        refused('unavailable');
        return;
      }
      if (outcome.outcome === 'refused') {
        abandon();
        refused(outcome.reason, {
          ...(outcome.bound === undefined ? {} : { bound: outcome.bound }),
          ...(outcome.limit === undefined ? {} : { limit: outcome.limit }),
          ...(outcome.count === undefined ? {} : { count: outcome.count }),
        });
        return;
      }
      if (ended) {
        abandon();
        void source.unsubscribe(holder, subscriptionId).catch(() => undefined);
        return;
      }
      claim.join(outcome.groupId);
      held.set(subscriptionId, { subscriber, claim, groupId: outcome.groupId });
      log.info('live subscription opened', { event: 'live.subscribed', subscriptionId, count: outcome.objectCount });
      send({
        type: 'subscribed', ref: message.ref, sub: subscriptionId, objectCount: outcome.objectCount, sources: outcome.sources,
        fields: outcome.fields, mode: outcome.mode ?? 'live',
        ...(outcome.refreshEverySeconds === null || outcome.refreshEverySeconds === undefined ? {} : { refreshEverySeconds: outcome.refreshEverySeconds }),
      });
      subscriber.activate(outcome.fields.granted);
    };

    const handle = async (message: ClientMessage): Promise<void> => {
      if (ended) return;
      if (message.type === 'subscribe' || message.type === 'unsubscribe') {
        // The person's doing: the idle clock moves, and an ended session is caught now.
        try {
          await resolveEdgeSession(services, session.token, 'websocket_client_message', { correlationId: uuidv7() });
          lastVerified = Date.now();
        } catch (error) {
          if (isAppError(error) && error.code === 'auth.session_invalid') {
            close(LIVE_CLOSE.sessionEnded, 'session ended');
            return;
          }
          throw error;
        }
      }
      switch (message.type) {
        case 'subscribe':
          await subscribe(message);
          return;
        case 'unsubscribe':
          if (held.has(message.sub)) {
            drop(message.sub);
            send({ type: 'unsubscribe', sub: message.sub, reason: 'requested' });
          }
          return;
        case 'resync_required': {
          const entry = held.get(message.sub);
          if (entry !== undefined) hub.requestResync(session.organisationId, entry.groupId, message.sub, message.lastSeq);
          return;
        }
        default:
      }
    };

    ws.on('message', (data, isBinary) => {
      lastHeard = Date.now();
      if (isBinary) {
        close(LIVE_CLOSE.unsupportedData, 'text frames only');
        return;
      }
      const now = Date.now();
      if (now - window.started >= 1000) window = { started: now, count: 0 };
      window.count += 1;
      if (window.count > live.clientMessagesPerSecond) {
        close(LIVE_CLOSE.tooManyMessages, 'too many messages');
        return;
      }
      let parsed: ReturnType<typeof clientMessage.safeParse> | undefined;
      try {
        parsed = clientMessage.safeParse(JSON.parse(textOf(data)));
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || !parsed.success) {
        close(LIVE_CLOSE.invalidMessage, 'invalid message');
        return;
      }
      const message = parsed.data;
      if (message.type === 'heartbeat') return;
      if (message.type === 'ack') {
        held.get(message.sub)?.subscriber.ack(message.seq);
        return;
      }
      queue = queue.then(() => handle(message)).catch((error: unknown) => {
        log.failure('a live message failed', error, { event: 'live.message_failed' });
        if (message.type === 'subscribe') send({ type: 'refused', ref: message.ref, reason: 'unavailable' });
      });
    });
    ws.on('close', end);
    ws.on('error', () => undefined);

    const heartbeat = setInterval(() => {
      if (Date.now() - lastHeard > (live.heartbeatSeconds * 2 + 5) * 1000) {
        close(LIVE_CLOSE.heartbeatMissed, 'heartbeat missed');
        return;
      }
      send({ type: 'heartbeat', at: new Date().toISOString() });
      if (held.size > 0) {
        const subscriptions = [...held.values()].map((h) => ({ subscriptionId: h.subscriber.subscriptionId, ackedSeq: h.subscriber.ackedSeq }));
        // A subscription the state plane no longer holds ends here too, so the client knows.
        void source.renew(holder, subscriptions).then((renewed) => {
          for (const subscriptionId of renewed?.ended ?? []) {
            if (!held.has(subscriptionId)) continue;
            drop(subscriptionId);
            send({ type: 'unsubscribe', sub: subscriptionId, reason: 'ended' });
          }
        }, () => undefined);
      }
    }, live.heartbeatSeconds * 1000);
    heartbeat.unref();

    const sessionCheck = setInterval(() => {
      sessionChecks.check(session.sessionId, session.token).then(() => {
        lastVerified = Date.now();
      }, (error: unknown) => {
        if (isAppError(error) && error.code === 'auth.session_invalid') close(LIVE_CLOSE.sessionEnded, 'session ended');
        else if (Date.now() - lastVerified > LIMITS.statePlane.revocationCloseSeconds * 1000) {
          close(LIVE_CLOSE.sessionUnverified, 'session could not be verified');
        }
      });
    }, live.sessionCheckSeconds * 1000);
    sessionCheck.unref();

    void watching.then((release) => {
      if (ended) release();
      else releaseWatch = release;
    }, (error: unknown) => {
      log.failure('the live bus did not take the subscription', error, { event: 'live.watch_failed' });
      close(LIVE_CLOSE.sessionUnverified, 'live updates unavailable');
    });
  }

  return {
    upgrade(req, socket, head) {
      socket.on('error', () => socket.destroy());
      const correlationId = uuidv7();
      void (async () => {
        try {
          if (closing) throw new AppError('unavailable', 'the gateway is stopping', { code: 'gateway.stopping', retryable: true });
          if ((req.url ?? '').split('?')[0] !== LIVE_PATH) throw new AppError('not_found', 'no such endpoint', { code: 'route.not_found' });
          checkWebSocketOrigin(req.headers, deps.publicOrigin);
          const client = edgeClientOf(req, config.http.trustProxyHops);
          await limiter.perAddress(client.address);
          const token = sessionTokenOf(req.headers.cookie);
          if (token === undefined) throw sessionRequired();
          const session = await resolveEdgeSession(services, token, 'http_request', { correlationId });
          requireComplete(session);
          await limiter.perSession(session.sessionId);
          const open = socketsBySession.get(session.sessionId) ?? 0;
          if (open >= live.socketsPerSession) throw refuse.bound('sockets_per_session', live.socketsPerSession, { count: open });
          if (closing) throw new AppError('unavailable', 'the gateway is stopping', { code: 'gateway.stopping', retryable: true });
          wss.handleUpgrade(req, socket, head, (ws) => connect(ws, session, correlationId));
        } catch (error) {
          refuseUpgrade(socket, error, correlationId);
        }
      })();
    },
    async close() {
      closing = true;
      const open = [...sockets];
      for (const ws of open) ws.close(LIVE_CLOSE.goingAway, 'the gateway is stopping');
      const deadline = Date.now() + 2_000;
      while (sockets.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    get openSockets() {
      return sockets.size;
    },
  };
}
