// The OAuth engine (spec 15.3, 15.4): one implementation for every provider. State, token
// exchange, scope checks and locked refresh. Tokens are exchanged and sealed by the
// credential service, so neither the authorisation code's tokens nor the client secret
// ever reach this service in clear.

import { oauthMetadata } from '../credential/oauthCredential.contract.ts';
import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const startOAuthFlow = defineContract({
  service: 'oauth', name: 'startOAuthFlow', method: 'POST', path: '/v1/oauth/flows', callers: ['gateway'],
  // Each call starts a new flow with its own state; an abandoned one expires (spec 15.3).
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid() }),
  response: z.object({ authorisationUrl: z.url(), expiresAt: z.string() }),
  maxBodyBytes: 1_024,
});

export const completeOAuthFlow = defineContract({
  service: 'oauth', name: 'completeOAuthFlow', method: 'POST', path: '/v1/oauth/callbacks', callers: ['gateway'],
  // The browser returns to the cell's one callback; the organisation is known only from the
  // state. The state is single use, so a repeat is refused.
  context: 'user', idempotency: 'none',
  body: z.strictObject({
    state: z.string().min(16).max(200),
    code: z.string().min(1).max(4_096).optional(),
    /** The provider's error code, when the person declined or the provider failed. */
    error: z.string().max(200).optional(),
  }),
  response: z.object({
    organisationId: z.uuid(),
    connectionId: z.uuid(),
    grantedScopes: z.array(z.string()),
  }),
  maxBodyBytes: 8_192,
});

export const refreshConnectionToken = defineContract({
  service: 'oauth', name: 'refreshConnectionToken', method: 'POST', path: '/v1/oauth/refreshes', callers: ['connect-runtime'],
  // Serialised by a lock: a concurrent or repeated call waits for the refresh in flight.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid() }),
  response: z.object({ expiresAt: z.string().nullable() }),
  maxBodyBytes: 1_024,
});

export const registerOAuthClient = defineContract({
  service: 'oauth', name: 'registerOAuthClient', method: 'POST', path: '/v1/oauth/clients', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    connectorId: z.uuid(),
    clientId: z.string().min(1).max(500),
    /** Absent for a public client. Sealed by the credential service. */
    clientSecret: z.string().min(1).max(4_096).optional(),
  }),
  response: z.object({ id: z.uuid(), connectorId: z.uuid(), clientId: z.string(), origin: z.string(), redirectUri: z.string() }),
  status: 201,
  maxBodyBytes: 8_192,
});

/**
 * A provider's discovery document (15.4 step 1): its authorisation and token endpoints, flows and
 * scopes with nothing typed, for a person or the AI builder writing an OAuth connector's manifest.
 */
export const discoverOAuthProvider = defineContract({
  service: 'oauth', name: 'discoverOAuthProvider', method: 'POST', path: '/v1/oauth/discovery', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(500) }),
  response: oauthMetadata,
});

/** A client as listed: whose it is and whether it holds a sealed secret, never the secret. */
export const oauthClientView = z.object({
  id: z.uuid(),
  connectorId: z.uuid(),
  origin: z.enum(['silo_registered', 'dynamic_registration', 'bring_your_own']),
  clientId: z.string(),
  /** A confidential client holds a sealed secret; a public one signs in with PKCE alone. */
  confidential: z.boolean(),
  metadataUrl: z.string().nullable(),
  redirectUri: z.string(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

/**
 * The organisation's OAuth clients (oauth_client.manage; spec 15.4–15.6): its own, and those
 * Silo registered for it dynamically, live ones unless the revoked are asked for. What the
 * page that registers and revokes them lists (D260).
 */
export const listOAuthClients = defineContract({
  service: 'oauth', name: 'listOAuthClients', method: 'GET', path: '/v1/oauth/clients', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ includeRevoked: z.enum(['true', 'false']).optional() }),
  response: z.object({ clients: z.array(oauthClientView) }),
});

/** An organisation's own client withdrawn (oauth_client.manage): no new sign-in uses it, and its secret is shredded. */
export const revokeOAuthClient = defineContract({
  service: 'oauth', name: 'revokeOAuthClient', method: 'DELETE', path: '/v1/oauth/clients/:clientId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ clientId: z.uuid() }),
  response: z.object({ revoked: z.boolean() }),
});

export const registerSiloOAuthClient = defineContract({
  service: 'oauth', name: 'registerSiloOAuthClient', method: 'POST', path: '/v1/oauth/silo-clients', callers: ['admin-portal'],
  // Silo registers its own application with a provider, for a catalogue connector (spec 15.4,
  // 15.5). The client belongs to the cell's system organisation; any organisation without
  // its own client for that connector uses it.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    /** The Silo operator acting, as admin-portal authenticated them. */
    operatorId: z.uuid(),
    connectorId: z.uuid(),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(4_096).optional(),
  }),
  response: z.object({ id: z.uuid(), connectorId: z.uuid(), clientId: z.string(), origin: z.string(), redirectUri: z.string() }),
  status: 201,
  maxBodyBytes: 8_192,
});
