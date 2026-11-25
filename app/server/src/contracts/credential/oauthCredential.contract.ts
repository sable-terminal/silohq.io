// The credential service's OAuth endpoints (spec 15.3). The token exchange and every refresh
// happen here, inside the mediator: the client secret, the PKCE verifier and the tokens are
// opened and sealed here and never leave. The OAuth engine holds the state and the lock.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const base64 = z.base64().max(16_384);

/** The OAuth client a flow uses: an organisation's own, or the cell's Silo-registered one. */
export const oauthClientRef = z.strictObject({
  id: z.uuid(),
  /** The client row's organisation: the system organisation for a Silo-registered client. */
  organisationId: z.uuid(),
  clientId: z.string().min(1).max(500),
  secretCredentialId: z.uuid().nullable(),
});
export type OAuthClientRef = z.infer<typeof oauthClientRef>;

export const sealOAuthVerifier = defineContract({
  service: 'credential', name: 'sealOAuthVerifier', method: 'POST', path: '/v1/oauth-verifiers', callers: ['oauth'],
  // A fresh seal each call; nothing is stored here.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ stateHash: z.string().regex(/^[0-9a-f]{64}$/), verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }),
  response: z.object({ sealed: base64 }),
  maxBodyBytes: 2_048,
});

export const exchangeAuthorisationCode = defineContract({
  service: 'credential', name: 'exchangeAuthorisationCode', method: 'POST', path: '/v1/oauth-exchanges', callers: ['oauth'],
  // An authorisation code is single use at the provider; a repeat is refused there.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    code: z.string().min(1).max(4_096),
    redirectUri: z.url(),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/),
    verifierSealed: base64.nullable(),
    client: oauthClientRef,
  }),
  response: z.object({ grantedScopes: z.array(z.string()), expiresAt: z.string().nullable() }),
  maxBodyBytes: 32_768,
});

export const refreshAccessToken = defineContract({
  service: 'credential', name: 'refreshAccessToken', method: 'POST', path: '/v1/oauth-refreshes', callers: ['oauth'],
  // Called under the OAuth engine's lock; a repeat refreshes again.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid(), client: oauthClientRef.nullable() }),
  response: z.object({ expiresAt: z.string().nullable(), rotated: z.boolean() }),
  maxBodyBytes: 4_096,
});

const endpoint = z.url({ protocol: /^https?$/ }).max(500);

/** An authorisation server's metadata (RFC 8414) or OIDC discovery document, as Silo reads it (spec 15.4 step 1). */
export const oauthMetadata = z.object({
  issuer: z.string(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string(),
  registrationEndpoint: z.string().nullable(),
  revocationEndpoint: z.string().nullable(),
  scopesSupported: z.array(z.string()),
  grantTypesSupported: z.array(z.string()),
  codeChallengeMethodsSupported: z.array(z.string()),
  /** The document's own address, as found. */
  metadataUrl: z.string(),
});
export type OAuthMetadata = z.infer<typeof oauthMetadata>;

/** Reads a provider's discovery document: the URL as given, or the issuer's well-known addresses. */
export const discoverOAuthMetadata = defineContract({
  service: 'credential', name: 'discoverOAuthMetadata', method: 'POST', path: '/v1/oauth-metadata', callers: ['oauth'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ url: endpoint }),
  response: oauthMetadata,
  maxBodyBytes: 2_048,
});

/**
 * Registers Silo as a client with a provider that implements RFC 7591 (spec 15.4 step 2): the
 * client id comes back; its secret and registration access token are sealed here and named by id.
 */
export const registerOAuthDynamicClient = defineContract({
  service: 'credential', name: 'registerOAuthDynamicClient', method: 'POST', path: '/v1/oauth-dynamic-clients', callers: ['oauth'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    registrationEndpoint: endpoint,
    clientName: z.string().min(1).max(200),
    redirectUri: endpoint,
    scopes: z.array(z.string().min(1).max(200)).max(100),
    tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']),
  }),
  response: z.object({ clientId: z.string(), clientSecretCredentialId: z.uuid().nullable(), registrationTokenCredentialId: z.uuid().nullable() }),
  maxBodyBytes: 8_192,
});

/** A revoked client's secret, crypto-shredded: the row stays for audit, its sealed columns gone. */
export const revokeOAuthClientSecret = defineContract({
  service: 'credential', name: 'revokeOAuthClientSecret', method: 'POST', path: '/v1/oauth-client-secrets/:credentialId/revocation', callers: ['oauth'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ credentialId: z.uuid() }),
  response: z.object({ revoked: z.boolean() }),
  maxBodyBytes: 1_024,
});

export const storeOAuthClientSecret = defineContract({
  service: 'credential', name: 'storeOAuthClientSecret', method: 'POST', path: '/v1/oauth-client-secrets', callers: ['oauth'],
  // Each call seals a new row; the client row names the one it uses.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ secret: z.string().min(1).max(4_096) }),
  response: z.object({ credentialId: z.uuid() }),
  maxBodyBytes: 8_192,
});
