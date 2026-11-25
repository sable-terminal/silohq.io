// Connect in the product (spec 14.9, 15.6, 16.6): browsing the catalogue, building a
// private connector and its versions, creating a connection, and registering the
// organisation's own OAuth client.
//
// Each route's permission is the one the forwarded service starts from; the service then
// applies its finer rules (connector.edit for a later version, the owner's rights over a
// connection). Routes whose rule is "the owner, or a permission at the owning scope"
// (parameters, secrets, status moves, conformance runs, OAuth) are in
// connectionRoutes.contract.ts, where the service decides.

import { browseCatalogue } from '../catalogue/catalogue.contract.ts';
import { createConnection as create } from '../connect-registry/connection.contract.ts';
import { createConnector as build, createManifestVersion as version } from '../connect-registry/connector.contract.ts';
import { discoverOAuthProvider as discover, listOAuthClients as listClients, registerOAuthClient as register, revokeOAuthClient as revokeClient } from '../oauth/oauth.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const browseConnectorCatalogue = definePublicRoute({
  name: 'browseConnectorCatalogue', method: 'GET', path: '/connect/catalogue', session: 'complete',
  // The catalogue is what a connection is made from (spec 14.9): whoever may create one may browse it.
  permission: { permission: 'connection.create' },
  query: browseCatalogue.query,
  response: browseCatalogue.response,
  forwards: browseCatalogue,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const createConnector = definePublicRoute({
  name: 'createConnector', method: 'POST', path: '/connect/connectors', session: 'complete',
  permission: { permission: 'connector.build' },
  body: build.body,
  response: build.response,
  status: 201,
  forwards: build,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const createManifestVersion = definePublicRoute({
  name: 'createManifestVersion', method: 'POST', path: '/connect/connectors/:connectorId/versions', session: 'complete',
  permission: { permission: 'connector.build' },
  params: version.params,
  body: version.body,
  response: version.response,
  status: 201,
  forwards: version,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

export const createConnection = definePublicRoute({
  name: 'createConnection', method: 'POST', path: '/connect/connections', session: 'complete',
  permission: { permission: 'connection.create', scopeId: (input) => input.body.owningScopeId },
  body: create.body,
  response: create.response,
  status: 201,
  forwards: create,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const registerOAuthClient = definePublicRoute({
  name: 'registerOAuthClient', method: 'POST', path: '/connect/oauth-clients', session: 'complete',
  permission: { permission: 'oauth_client.manage' },
  body: register.body,
  response: register.response,
  status: 201,
  forwards: register,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const revokeOAuthClient = definePublicRoute({
  name: 'revokeOAuthClient', method: 'DELETE', path: '/connect/oauth-clients/:clientId', session: 'complete',
  permission: { permission: 'oauth_client.manage' },
  params: revokeClient.params, response: revokeClient.response, forwards: revokeClient,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listOAuthClients = definePublicRoute({
  name: 'listOAuthClients', method: 'GET', path: '/connect/oauth-clients', session: 'complete',
  permission: { permission: 'oauth_client.manage' },
  query: listClients.query, response: listClients.response, forwards: listClients,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const discoverOAuthProvider = definePublicRoute({
  name: 'discoverOAuthProvider', method: 'POST', path: '/connect/oauth-discovery', session: 'complete',
  permission: { permission: 'oauth_client.manage' },
  body: discover.body, response: discover.response, forwards: discover,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const CONNECT_ROUTES = [
  browseConnectorCatalogue, createConnector, createManifestVersion, createConnection, registerOAuthClient, revokeOAuthClient, listOAuthClients, discoverOAuthProvider,
] as const;
