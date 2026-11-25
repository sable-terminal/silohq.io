// The OAuth engine's endpoints.

import type {
  completeOAuthFlow, discoverOAuthProvider, listOAuthClients, refreshConnectionToken, registerOAuthClient, registerSiloOAuthClient, revokeOAuthClient, startOAuthFlow,
} from '../../contracts/oauth/oauth.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { OauthClient } from '../../models/connect/oauthClient.model.ts';
import * as oauth from '../../services/oauth/oauth.service.ts';
import type { OAuthDeps } from '../../services/oauth/oauth.service.ts';

const clientView = (row: OauthClient) => ({ id: row.id, connectorId: row.connectorId, clientId: row.clientId, origin: row.origin, redirectUri: row.redirectUri });
const listedView = (row: OauthClient) => ({
  id: row.id, connectorId: row.connectorId, origin: row.origin, clientId: row.clientId, confidential: row.clientSecretCredentialId !== null,
  metadataUrl: row.metadataUrl, redirectUri: row.redirectUri, createdBy: row.createdBy, createdAt: row.createdAt, revokedAt: row.revokedAt,
});

export function oauthController(deps: OAuthDeps) {
  return {
    start: { handle: ({ body }, ctx) => oauth.startFlow(deps, ctx, body.connectionId) } satisfies RouteHandlers<typeof startOAuthFlow>,
    complete: { handle: ({ body }, ctx) => oauth.completeFlow(deps, ctx, body) } satisfies RouteHandlers<typeof completeOAuthFlow>,
    refresh: { handle: ({ body }, ctx) => oauth.refreshToken(deps, ctx, body.connectionId) } satisfies RouteHandlers<typeof refreshConnectionToken>,
    register: {
      handle: async ({ body }, ctx) => clientView(await oauth.registerClient(deps, ctx, body)),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => clientView(await oauth.getClient(deps, ctx, ref!)),
    } satisfies RouteHandlers<typeof registerOAuthClient>,
    discover: { handle: ({ body }, ctx) => oauth.discoverProvider(deps, ctx, body.url) } satisfies RouteHandlers<typeof discoverOAuthProvider>,
    revoke: { handle: ({ params }, ctx) => oauth.revokeClient(deps, ctx, params.clientId) } satisfies RouteHandlers<typeof revokeOAuthClient>,
    list: {
      handle: async ({ query }, ctx) => ({ clients: (await oauth.listClients(deps, ctx, query.includeRevoked === 'true')).map(listedView) }),
    } satisfies RouteHandlers<typeof listOAuthClients>,
    registerSilo: {
      handle: async ({ body }, ctx) => clientView(await oauth.registerSiloClient(deps, ctx, body)),
    } satisfies RouteHandlers<typeof registerSiloOAuthClient>,
  };
}
