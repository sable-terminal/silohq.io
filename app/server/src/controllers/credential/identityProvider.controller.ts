// The credential service's identity provider endpoints: contracts to the mediator.

import type {
  completeFederatedSignIn, directoryEmailHash, readIdentityProvider, readServiceProviderMetadata, receiveSamlLogout, startFederatedSignIn,
  startSamlLogout, storeIdentityProvider,
} from '../../contracts/credential/identityProvider.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Caller } from '../../services/credential/connectionCredential.service.ts';
import type { DirectoryHasher } from '../../services/credential/directoryHash.service.ts';
import type { IdentityProviders } from '../../services/credential/identityProvider.service.ts';

const callerOf = (ctx: HandlerContext): Caller => ({ request: ctx.request, caller: ctx.caller, correlationId: ctx.correlationId });

export function identityProviderController(providers: IdentityProviders, hasher: DirectoryHasher): {
  store: RouteHandlers<typeof storeIdentityProvider>;
  read: RouteHandlers<typeof readIdentityProvider>;
  start: RouteHandlers<typeof startFederatedSignIn>;
  complete: RouteHandlers<typeof completeFederatedSignIn>;
  directoryHash: RouteHandlers<typeof directoryEmailHash>;
  metadata: RouteHandlers<typeof readServiceProviderMetadata>;
  logoutStart: RouteHandlers<typeof startSamlLogout>;
  logoutReceive: RouteHandlers<typeof receiveSamlLogout>;
} {
  return {
    store: { handle: (input, ctx) => providers.store(callerOf(ctx), input.params.providerId, input.body) },
    read: { handle: (input, ctx) => providers.read(callerOf(ctx), input.params.providerId) },
    start: { handle: (input, ctx) => providers.start(callerOf(ctx), input.params.providerId, input.body) },
    complete: { handle: (input, ctx) => providers.complete(callerOf(ctx), input.params.providerId, input.body) },
    directoryHash: { handle: (input) => hasher.hash(input.body.email) },
    metadata: { handle: async (input) => providers.metadata(input.body) },
    logoutStart: { handle: (input, ctx) => providers.logoutStart(callerOf(ctx), input.params.providerId, input.body) },
    logoutReceive: { handle: (input, ctx) => providers.logoutReceive(callerOf(ctx), input.params.providerId, input.body) },
  };
}
