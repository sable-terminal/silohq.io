// The credential service's OAuth endpoints: wire shapes (base64) to the mediator and back.

import type {
  discoverOAuthMetadata, exchangeAuthorisationCode, refreshAccessToken, registerOAuthDynamicClient, revokeOAuthClientSecret, sealOAuthVerifier, storeOAuthClientSecret,
} from '../../contracts/credential/oauthCredential.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Caller } from '../../services/credential/connectionCredential.service.ts';
import type { OAuthCredentials } from '../../services/credential/oauthCredential.service.ts';

const callerOf = (ctx: HandlerContext): Caller => ({ request: ctx.request, caller: ctx.caller, correlationId: ctx.correlationId });

export function oauthCredentialController(oauth: OAuthCredentials) {
  return {
    sealVerifier: {
      handle: async ({ body }, ctx) => ({ sealed: (await oauth.sealVerifier(callerOf(ctx), body.stateHash, body.verifier)).toString('base64') }),
    } satisfies RouteHandlers<typeof sealOAuthVerifier>,
    exchange: {
      handle: ({ body }, ctx) => oauth.exchange(callerOf(ctx), {
        ...body, verifierSealed: body.verifierSealed === null ? null : Buffer.from(body.verifierSealed, 'base64'),
      }),
    } satisfies RouteHandlers<typeof exchangeAuthorisationCode>,
    refresh: {
      handle: ({ body }, ctx) => oauth.refresh(callerOf(ctx), body.connectionId, body.client),
    } satisfies RouteHandlers<typeof refreshAccessToken>,
    discover: {
      handle: ({ body }, ctx) => oauth.discover(callerOf(ctx), body.url),
    } satisfies RouteHandlers<typeof discoverOAuthMetadata>,
    registerDynamic: {
      handle: ({ body }, ctx) => oauth.registerDynamic(callerOf(ctx), body),
    } satisfies RouteHandlers<typeof registerOAuthDynamicClient>,
    revokeClientSecret: {
      handle: async ({ params }, ctx) => ({ revoked: await oauth.revokeClientSecret(callerOf(ctx), params.credentialId) }),
    } satisfies RouteHandlers<typeof revokeOAuthClientSecret>,
    storeClientSecret: {
      handle: async ({ body }, ctx) => ({ credentialId: await oauth.storeClientSecret(callerOf(ctx), body.secret) }),
    } satisfies RouteHandlers<typeof storeOAuthClientSecret>,
  };
}
