// Federated sign-in (spec 55.5; design: iam.identity_providers, iam.user_identities), for
// the gateway.
//
// The flow, for OIDC and SAML alike:
// 1. startSso: auth keeps the flow in redis-data under a hash of its state, and returns
//    the provider's URL with a browser binding. The binding stays in the browser that
//    started (the app keeps it for the tab) and is never stored here: only its hash, and
//    the PKCE verifier is derived from it, so the flow cannot be finished elsewhere.
// 2. OIDC: the provider sends the browser to the app's callback page, which posts the
//    query and the binding to completeOidcSignIn.
//    SAML: the provider posts the response to the gateway's assertion consumer, which
//    hands it to receiveSamlResponse and sends the browser on with a ticket; the app posts
//    the ticket and the binding to completeSamlSignIn. The cross-site post can read no
//    binding, so it only turns a verified answer into a ticket the binding must redeem.
// 3. auth links the provider's stable subject to a user, never matching by address (review
//    D1): a link exists, or the flow proves one by an invitation, by just-in-time creation
//    of a new person, or by the signed-in person linking their own account.

import { z } from 'zod';
import { oidcSettings, samlSettings, identityProviderView } from '../credential/identityProvider.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { client, sessionToken, sessionView } from './session.contract.ts';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
/** A state, relay state or ticket: the organisation, then 32 random bytes. */
export const flowHandle = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
const binding = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const providerSummary = z.object({
  providerId: z.uuid(),
  kind: z.enum(['oidc', 'saml']),
  issuer: z.string(),
  active: z.boolean(),
  jitProvisioning: z.boolean(),
  defaultRoleId: z.uuid().nullable(),
  defaultScopeId: z.uuid().nullable(),
  version: z.number().int(),
});

export const listSignInOptions = defineContract({
  service: 'auth', name: 'listSignInOptions', method: 'GET', path: '/v1/sign-in-options', callers: ['gateway'],
  // What the sign-in page offers for an organisation: whether SSO is required, and its
  // active providers. An unknown organisation offers nothing, as an inactive one does.
  context: 'none', idempotency: 'none',
  query: z.strictObject({ organisationSlug: slug }),
  response: z.object({
    ssoRequired: z.boolean(),
    providers: z.array(z.object({ providerId: z.uuid(), kind: z.enum(['oidc', 'saml']) })),
  }),
});

export const startSso = defineContract({
  service: 'auth', name: 'startSso', method: 'POST', path: '/v1/sso/starts', callers: ['gateway'],
  // Each call starts a new flow; an unused one expires.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationSlug: slug,
    providerId: z.uuid(),
    /** Accepting an invitation by SSO: the token proves the address (linked_via invitation). */
    invitationToken: z.string().regex(/^silo_inv_[A-Za-z0-9_-]{43}$/).optional(),
  }),
  response: z.object({
    redirectUrl: z.url({ protocol: /^https?$/ }),
    binding,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  status: 201,
  maxBodyBytes: 2048,
});

export const startSsoLink = defineContract({
  service: 'auth', name: 'startSsoLink', method: 'POST', path: '/v1/sso/links', callers: ['gateway'],
  // The signed-in person links a provider identity to their own account (linked_via
  // existing_session). The gateway sends this only for a complete session (MFA done), with
  // the session's organisation, membership and user as the context.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ providerId: z.uuid() }),
  response: startSso.response,
  status: 201,
  maxBodyBytes: 1024,
});

export const completeOidcSignIn = defineContract({
  service: 'auth', name: 'completeOidcSignIn', method: 'POST', path: '/v1/sso/oidc/completions', callers: ['gateway'],
  // The flow is used once: a second attempt finds nothing.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    /** The query string the provider sent the browser back with. */
    callbackQuery: z.string().min(1).max(8192),
    binding,
    client: client.optional(),
  }),
  response: sessionView.extend({ sessionToken }),
  status: 201,
  maxBodyBytes: 16_384,
});

export const receiveSamlResponse = defineContract({
  service: 'auth', name: 'receiveSamlResponse', method: 'POST', path: '/v1/sso/saml/responses', callers: ['gateway'],
  // Verifies the posted response for the flow its relay state names, once, and returns a
  // ticket for the browser that started it.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    samlResponse: z.string().min(1).max(512_000),
    relayState: flowHandle,
  }),
  response: z.object({ ticket: flowHandle }),
  maxBodyBytes: 600_000,
});

export const completeSamlSignIn = defineContract({
  service: 'auth', name: 'completeSamlSignIn', method: 'POST', path: '/v1/sso/saml/completions', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ ticket: flowHandle, binding, client: client.optional() }),
  response: sessionView.extend({ sessionToken }),
  status: 201,
  maxBodyBytes: 2048,
});

export const listIdentityProviders = defineContract({
  service: 'auth', name: 'listIdentityProviders', method: 'GET', path: '/v1/identity-providers', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ providers: z.array(providerSummary) }),
});

export const readIdentityProviderConfig = defineContract({
  service: 'auth', name: 'readIdentityProviderConfig', method: 'GET', path: '/v1/identity-providers/:providerId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  response: identityProviderView,
});

export const configureIdentityProvider = defineContract({
  service: 'auth', name: 'configureIdentityProvider', method: 'PUT', path: '/v1/identity-providers/:providerId', callers: ['gateway'],
  // Creates the provider (expectedVersion null) or replaces its configuration at the version
  // read, under org.sso.manage. A SAML provider may be given its metadata document instead
  // of its settings; a new metadata document is how a certificate rolls over.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  body: z.strictObject({
    expectedVersion: z.number().int().min(1).nullable(),
    jitProvisioning: z.boolean().default(false),
    defaultRoleId: z.uuid().nullable().default(null),
    defaultScopeId: z.uuid().nullable().default(null),
    active: z.boolean(),
    config: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('oidc'), issuer: z.url({ protocol: /^https?$/ }), settings: oidcSettings, clientSecret: z.string().min(1).max(4096).optional() }),
      z.strictObject({
        kind: z.literal('saml'),
        /** Settings to use, or the IdP's metadata XML to read them from (with any overrides in settings). */
        settings: samlSettings.optional(),
        metadataXml: z.string().min(1).max(256_000).optional(),
        overrides: z.strictObject({
          emailAttribute: z.string().min(1).max(256).optional(),
          givenNameAttribute: z.string().min(1).max(256).optional(),
          familyNameAttribute: z.string().min(1).max(256).optional(),
          trustProviderMfa: z.boolean().optional(),
          wantResponseSigned: z.boolean().optional(),
          /** Refuse an assertion not encrypted to the cell's SP certificate (spec 55.5). */
          requireEncryptedAssertions: z.boolean().optional(),
        }).optional(),
      }),
    ]),
  }),
  response: identityProviderView,
  maxBodyBytes: 300_000,
});

/** The cell's SAML SP metadata (spec 55.5): with a provider named, its single logout address too. */
export const readSamlMetadata = defineContract({
  service: 'auth', name: 'readSamlMetadata', method: 'GET', path: '/v1/sso/saml/metadata', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  query: z.strictObject({ organisationId: z.uuid().optional(), providerId: z.uuid().optional() }),
  response: z.object({ xml: z.string() }),
});

/**
 * Signing out of a session that came from a SAML provider with single logout (spec 55.5): the
 * session ends here at once, and the browser is sent on to the provider with a signed
 * LogoutRequest so its session ends too. Null where there is no provider to tell.
 */
export const beginSingleLogout = defineContract({
  service: 'auth', name: 'beginSingleLogout', method: 'POST', path: '/v1/sso/saml/logouts', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken: z.string().min(1).max(200) }),
  response: z.object({ logoutUrl: z.url({ protocol: /^https?$/ }).nullable() }),
  maxBodyBytes: 1024,
});

/**
 * A logout message from a provider at the gateway's single logout address: a LogoutRequest ends
 * the person's sessions from that provider (that session's, where it names one) and answers
 * with a LogoutResponse; a LogoutResponse to ours completes the sign-out. Where the browser goes next.
 */
export const receiveSamlLogoutMessage = defineContract({
  service: 'auth', name: 'receiveSamlLogoutMessage', method: 'POST', path: '/v1/sso/saml/logout-messages', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationId: z.uuid(), providerId: z.uuid(),
    message: z.discriminatedUnion('binding', [
      z.strictObject({ binding: z.literal('redirect'), query: z.string().min(1).max(64_000) }),
      z.strictObject({ binding: z.literal('post'), samlRequest: z.string().max(512_000).optional(), samlResponse: z.string().max(512_000).optional(), relayState: z.string().max(200).optional() }),
    ]),
  }),
  response: z.object({ redirectUrl: z.url({ protocol: /^https?$/ }) }),
  maxBodyBytes: 600_000,
});
