// The OAuth engine (catalogue: oauth): state, token exchange, scope checks and locked
// refresh, for every provider. Tokens are exchanged and sealed by the credential service.

import {
  completeOAuthFlow, discoverOAuthProvider, listOAuthClients, refreshConnectionToken, registerOAuthClient, registerSiloOAuthClient, revokeOAuthClient, startOAuthFlow,
} from '../../contracts/oauth/oauth.contract.ts';
import { oauthController } from '../../controllers/oauth/oauth.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { expireFlows } from '../../services/oauth/oauth.service.ts';
import { sleep } from '../../utils/time.util.ts';

/** sweepMs: how often unfinished sign-ins past their expiry are marked expired (default a minute; tests shorten it). */
export const createOAuthService = (options: { sweepMs?: number } = {}): ServiceDefinition => defineService({
  name: 'oauth',
  // redis-data: the refresh locks and the idempotency keys.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = oauthController({ databases: deps.databases, services: deps.services, data: deps.redis.data!, config: deps.config.connect });
    return {
      routes: [route(startOAuthFlow, c.start), route(completeOAuthFlow, c.complete), route(refreshConnectionToken, c.refresh), route(registerOAuthClient, c.register),
        route(registerSiloOAuthClient, c.registerSilo), route(revokeOAuthClient, c.revoke), route(discoverOAuthProvider, c.discover),
        route(listOAuthClients, c.list)],
      workers: [{
        name: 'oauth-flow-expiry',
        async run(signal) {
          while (!signal.aborted) {
            await expireFlows({ databases: deps.databases }).catch((error: unknown) =>
              deps.logger.failure('unfinished sign-ins could not be expired; the next round retries', error, { event: 'oauth.expiry_failed' }));
            await sleep(options.sweepMs ?? 60_000, signal).catch(() => undefined);
          }
        },
      }],
    };
  },
});

export const service: ServiceDefinition = createOAuthService();
