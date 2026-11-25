// The auth service's federated sign-in endpoints: contracts to services/auth/sso.

import type {
  completeOidcSignIn, completeSamlSignIn, configureIdentityProvider, listIdentityProviders, listSignInOptions, readIdentityProviderConfig,
  beginSingleLogout, readSamlMetadata, receiveSamlLogoutMessage, receiveSamlResponse, startSso, startSsoLink,
} from '../../contracts/auth/sso.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as sso from '../../services/auth/sso.service.ts';

export function ssoController(deps: AuthDeps): {
  listSignInOptions: RouteHandlers<typeof listSignInOptions>;
  startSso: RouteHandlers<typeof startSso>;
  startSsoLink: RouteHandlers<typeof startSsoLink>;
  completeOidcSignIn: RouteHandlers<typeof completeOidcSignIn>;
  receiveSamlResponse: RouteHandlers<typeof receiveSamlResponse>;
  completeSamlSignIn: RouteHandlers<typeof completeSamlSignIn>;
  readSamlMetadata: RouteHandlers<typeof readSamlMetadata>;
  beginSingleLogout: RouteHandlers<typeof beginSingleLogout>;
  receiveSamlLogoutMessage: RouteHandlers<typeof receiveSamlLogoutMessage>;
  listIdentityProviders: RouteHandlers<typeof listIdentityProviders>;
  readIdentityProviderConfig: RouteHandlers<typeof readIdentityProviderConfig>;
  configureIdentityProvider: RouteHandlers<typeof configureIdentityProvider>;
} {
  return {
    listSignInOptions: { handle: (input) => sso.signInOptions(deps, input.query.organisationSlug) },
    startSso: { handle: (input, ctx) => sso.startSso(deps, input.body, ctx.correlationId) },
    startSsoLink: { handle: (input, ctx) => sso.startLink(deps, ctx, input.body.providerId) },
    completeOidcSignIn: { handle: (input, ctx) => sso.completeOidc(deps, input.body, ctx.correlationId) },
    receiveSamlResponse: { handle: (input, ctx) => sso.receiveSaml(deps, input.body, ctx.correlationId) },
    completeSamlSignIn: { handle: (input, ctx) => sso.completeSaml(deps, input.body, ctx.correlationId) },
    readSamlMetadata: { handle: (input, ctx) => sso.samlMetadata(deps, input.query, ctx.correlationId) },
    beginSingleLogout: { handle: (input, ctx) => sso.beginSingleLogout(deps, input.body.sessionToken, ctx.correlationId) },
    receiveSamlLogoutMessage: { handle: (input, ctx) => sso.receiveSamlLogout(deps, input.body, ctx.correlationId) },
    listIdentityProviders: { handle: (_input, ctx) => sso.listProviders(deps, ctx) },
    readIdentityProviderConfig: { handle: (input, ctx) => sso.readProvider(deps, ctx, input.params.providerId) },
    configureIdentityProvider: { handle: (input, ctx) => sso.configureProvider(deps, ctx, input.params.providerId, input.body) },
  };
}
