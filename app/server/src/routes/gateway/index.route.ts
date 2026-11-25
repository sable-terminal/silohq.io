// The gateway (spec 7.3): the public HTTP and WebSocket API. TLS, rate limits, routing to
// the internal services through their contracts, and live clone fan-out from bus-live.
//
// It serves browsers on its own listener (GATEWAY_PUBLIC_PORT); the process's service
// listener carries only the orchestrator's probes, since no service calls the gateway.
// On shutdown the public listener keeps serving through the drain, then sockets close as
// going away (clients reconnect with backoff, spec 30.6) and requests in flight finish.

import { readFileSync } from 'node:fs';
import { required } from '../../config/index.config.ts';
import type { PublicRoute } from '../../contracts/gateway/publicRoute.contract.ts';
import { PUBLIC_ROUTES } from '../../contracts/gateway/routeTable.contract.ts';
import { createEdgeApp } from '../../controllers/gateway/edge.controller.ts';
import { createLiveEndpoint } from '../../controllers/gateway/live.controller.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { openPublicListener } from '../../services/gateway/listener.service.ts';
import { createLiveHub } from '../../services/gateway/liveHub.service.ts';
import { createEdgeLimiter } from '../../middleware/rateLimit.middleware.ts';
import { statePlaneSource, type SubscriptionSource } from '../../services/gateway/subscriptionSource.service.ts';
import { loadWebClient } from '../../services/gateway/webClient.service.ts';

export interface GatewayOptions {
  /** Where live subscriptions are opened: the state plane unless a test gives another. */
  subscriptionSource?: SubscriptionSource;
  /** The public routes; the routing table unless a test narrows it. */
  routes?: readonly PublicRoute[];
  /** Called with the public port once it listens (port 0 takes any free port). */
  onListening?: (port: number) => void;
  /** The live coalescing window, for tests. */
  coalesceMs?: number;
}

export function createGatewayService(options: GatewayOptions = {}): ServiceDefinition {
  return defineService({
    name: 'gateway',
    needs: { redis: ['data'], bus: ['live'] },
    async create(deps) {
      const { config, logger, services } = deps;
      const publicOrigin = required(config.gateway.publicOrigin, 'GATEWAY_PUBLIC_ORIGIN');
      const identifierKey = required(config.security.identifierHashKey, 'IDENTIFIER_HASH_KEY');
      const routes = options.routes ?? PUBLIC_ROUTES;
      const limiter = createEdgeLimiter(deps.redis.data!, identifierKey, config.gateway.rateLimits);
      const live = createLiveEndpoint({
        config, publicOrigin, logger, services, limiter, hub: createLiveHub(deps.liveBus!, logger),
        source: options.subscriptionSource ?? statePlaneSource(services),
        ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
      });
      const web = config.gateway.webRoot === undefined ? undefined : await loadWebClient(config.gateway.webRoot, { connectOrigins: config.gateway.uploadOrigins });
      if (web !== undefined) logger.info('web client loaded', { event: 'gateway.web_client_loaded', count: web.files.size, bytes: web.bytes });
      const app = createEdgeApp({ config, publicOrigin, logger, services, limiter, routes, web });
      const tls = config.gateway.tls === undefined ? undefined
        : { cert: readFileSync(config.gateway.tls.certFile), key: readFileSync(config.gateway.tls.keyFile) };
      const listener = await openPublicListener({
        host: config.gateway.publicHost, port: config.gateway.publicPort, tls, handler: app, upgrade: live.upgrade,
        requestTimeoutMs: config.http.requestTimeoutMs,
      });
      logger.info('public listener started', { event: 'gateway.listening', count: routes.length });
      options.onListening?.(listener.port);

      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        stopping ??= (async () => {
          await live.close();
          await listener.close(config.http.shutdownTimeoutMs);
        })();
        return stopping;
      };
      return {
        routes: [],
        workers: [{
          name: 'gateway-edge',
          async run(signal) {
            if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            await stop();
          },
        }],
        close: stop,
      };
    },
  });
}

export const service = createGatewayService();
