// Identity providers in the mediator (spec 55.5, 61.3; design: iam.identity_providers).
//
// An organisation's provider configuration, an OIDC client secret included, is sealed here
// (AAD: id, organisation, kind) and opened only here. auth runs the sign-in flow and
// decides who the person is; this service turns the flow's pieces into the provider's
// authorisation URL, and the provider's answer into a verified identity, with the
// libraries doing the verification:
// - OIDC (openid-client): discovery, PKCE, the code exchange with the client secret, and
//   the ID token's signature, issuer, audience, nonce and expiry;
// - SAML (@node-saml): the XML signature, audience, recipient, InResponseTo and validity.
// Every open is an unwrap in iam.credential_unwraps: reason idp to configure or start,
// sso_assert to verify an answer. The secret never leaves; a read returns the rest.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const claim = z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/);
const pem = z.string().min(64).max(16_384);

/** What an OIDC provider is told and trusted for. Every provider is values of this, never code. */
export const oidcSettings = z.strictObject({
  clientId: z.string().min(1).max(512),
  /** client_secret_basic or client_secret_post need a secret; none is a public client with PKCE alone. */
  clientAuth: z.enum(['client_secret_basic', 'client_secret_post', 'none']).default('client_secret_basic'),
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/)).min(1).max(20).default(['openid', 'email', 'profile']),
  /**
   * The ID token claims whose values, joined by ':', are the stable subject (design:
   * iam.user_identities.subject): ['sub'] by default; a multi-tenant directory's tenant and
   * object id claims where its sub is pairwise per application (design: tid:oid).
   */
  subjectClaims: z.array(claim).min(1).max(4).default(['sub']),
  emailClaim: claim.default('email'),
  /** The claim saying the address is verified; null when the provider only issues verified addresses. */
  emailVerifiedClaim: claim.nullable().default('email_verified'),
  givenNameClaim: claim.default('given_name'),
  familyNameClaim: claim.default('family_name'),
  /** Accept the provider's MFA (an amr value below) as satisfying the organisation's MFA rule. */
  trustProviderMfa: z.boolean().default(false),
  mfaAmrValues: z.array(claim).max(20).default(['mfa', 'otp', 'hwk', 'swk', 'fido', 'sc']),
});
export type OidcSettings = z.output<typeof oidcSettings>;

/** What a SAML identity provider is told and trusted for: from its metadata, or entered. */
export const samlSettings = z.strictObject({
  /** The IdP's entity id; the Issuer of its responses. */
  entityId: z.string().min(1).max(2048),
  /** Its SingleSignOnService for the HTTP-Redirect binding. */
  ssoUrl: z.url({ protocol: /^https?$/ }),
  /** Its SingleLogoutService for the HTTP-Redirect binding, where it has one: single logout (spec 55.5). */
  sloUrl: z.url({ protocol: /^https?$/ }).optional(),
  /** Refuse an assertion that is not encrypted to the cell's SP certificate. */
  requireEncryptedAssertions: z.boolean().default(false),
  /** Its signing certificates, PEM or base64 DER. More than one during a rollover: any verifies. */
  signingCertificates: z.array(pem).min(1).max(4),
  nameIdFormat: z.string().max(200).default('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'),
  /** Which parts must be signed. At least one; the assertion by default. */
  wantAssertionsSigned: z.boolean().default(true),
  wantResponseSigned: z.boolean().default(false),
  emailAttribute: z.string().min(1).max(256).default('email'),
  givenNameAttribute: z.string().min(1).max(256).default('firstName'),
  familyNameAttribute: z.string().min(1).max(256).default('lastName'),
  /** SAML providers assert only addresses they manage; false where that is not so. */
  emailsVerified: z.boolean().default(true),
  trustProviderMfa: z.boolean().default(false),
  /** The AuthnContextClassRef values that mean MFA. A provider's own values are configuration, never code. */
  mfaAuthnContexts: z.array(z.string().max(256)).max(10).default(['urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract']),
}).refine((s) => s.wantAssertionsSigned || s.wantResponseSigned, 'the assertion or the response must be signed');
export type SamlSettings = z.output<typeof samlSettings>;

const providerFields = {
  issuer: z.string().min(1).max(2048),
  jitProvisioning: z.boolean(),
  defaultRoleId: z.uuid().nullable(),
  defaultScopeId: z.uuid().nullable(),
  active: z.boolean(),
};

export const storeIdentityProvider = defineContract({
  service: 'credential', name: 'storeIdentityProvider', method: 'PUT', path: '/v1/identity-providers/:providerId', callers: ['auth'],
  // Creates the provider, or replaces its configuration at the version given; auth decided
  // org.sso.manage. An OIDC secret left out keeps the stored one.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  body: z.strictObject({
    ...providerFields,
    expectedVersion: z.number().int().min(1).nullable(),
    /** The membership configuring it; just-in-time grants are made as this member (design: role_assignments). */
    configuredBy: z.uuid(),
    config: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('oidc'), settings: oidcSettings, clientSecret: z.string().min(1).max(4096).optional() }),
      z.strictObject({ kind: z.literal('saml'), settings: samlSettings }),
    ]),
  }),
  response: z.object({ providerId: z.uuid(), kind: z.enum(['oidc', 'saml']), version: z.number().int(), active: z.boolean() }),
  maxBodyBytes: 65_536,
});

/** A provider as anyone may see it: the configuration without the secret. */
export const identityProviderView = z.object({
  providerId: z.uuid(),
  ...providerFields,
  version: z.number().int(),
  configuredBy: z.uuid().nullable(),
  config: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('oidc'), settings: oidcSettings, hasClientSecret: z.boolean() }),
    z.object({ kind: z.literal('saml'), settings: samlSettings }),
  ]),
});
export type IdentityProviderView = z.infer<typeof identityProviderView>;

export const readIdentityProvider = defineContract({
  service: 'credential', name: 'readIdentityProvider', method: 'GET', path: '/v1/identity-providers/:providerId', callers: ['auth'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  response: identityProviderView,
});

export const startFederatedSignIn = defineContract({
  service: 'credential', name: 'startFederatedSignIn', method: 'POST', path: '/v1/identity-providers/:providerId/sign-ins',
  callers: ['auth'],
  // Builds the request to the provider; stores nothing (auth keeps the flow).
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  body: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('oidc'),
      redirectUri: z.url({ protocol: /^https?$/ }),
      state: z.string().regex(/^[A-Za-z0-9_.-]{32,200}$/),
      nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
      codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }),
    z.strictObject({
      kind: z.literal('saml'),
      acsUrl: z.url({ protocol: /^https?$/ }),
      spEntityId: z.string().min(1).max(2048),
      relayState: z.string().regex(/^[A-Za-z0-9_.-]{32,200}$/),
      requestId: z.string().regex(/^_[0-9a-f]{32,64}$/),
    }),
  ]),
  response: z.object({ redirectUrl: z.url({ protocol: /^https?$/ }) }),
  maxBodyBytes: 8192,
});

/** Who the provider says the person is. The subject is what links; the address never does (design: iam.user_identities). */
export const federatedIdentity = z.object({
  subject: z.string().min(1).max(512),
  email: z.email().max(320).nullable(),
  emailVerified: z.boolean(),
  firstName: z.string().max(200).nullable(),
  lastName: z.string().max(200).nullable(),
  /** The provider performed MFA and the configuration trusts it. */
  mfa: z.boolean(),
  configuredBy: z.uuid().nullable(),
  /** A SAML sign-in's session at the provider, for single logout: identifiers, never secrets. */
  saml: z.object({ nameId: z.string().max(512), nameIdFormat: z.string().max(200), sessionIndex: z.string().max(512).nullable() }).optional(),
});
export type FederatedIdentity = z.infer<typeof federatedIdentity>;

export const completeFederatedSignIn = defineContract({
  service: 'credential', name: 'completeFederatedSignIn', method: 'POST', path: '/v1/identity-providers/:providerId/assertions',
  callers: ['auth'],
  // Verifies the provider's answer. A code is single use at the provider; an InResponseTo
  // must be the request auth started.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  body: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('oidc'),
      redirectUri: z.url({ protocol: /^https?$/ }),
      /** The query the provider sent the browser back with: code and state, or an error. */
      callbackQuery: z.string().min(1).max(8192),
      expectedState: z.string().regex(/^[A-Za-z0-9_.-]{32,200}$/),
      expectedNonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
      codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    }),
    z.strictObject({
      kind: z.literal('saml'),
      acsUrl: z.url({ protocol: /^https?$/ }),
      spEntityId: z.string().min(1).max(2048),
      samlResponse: z.string().min(1).max(512_000),
      relayState: z.string().regex(/^[A-Za-z0-9_.-]{32,200}$/),
      expectedRequestId: z.string().regex(/^_[0-9a-f]{32,64}$/),
    }),
  ]),
  response: federatedIdentity,
  maxBodyBytes: 600_000,
});

export const directoryEmailHash = defineContract({
  service: 'credential', name: 'directoryEmailHash', method: 'POST', path: '/v1/directory-hashes', callers: ['auth', 'tenant-migrations'],
  // The keyed hash the directory routes a login by (spec 55.1), computed with the directory
  // key inside the KMS; the address never leaves the cell. tenant-migrations registers each
  // member of an organisation that has moved here (spec 6.4).
  context: 'none', idempotency: 'none',
  body: z.strictObject({ email: z.email().max(320) }),
  response: z.object({ emailHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/), keyVersion: z.number().int().min(1) }),
  maxBodyBytes: 1024,
});

const spEndpoints = {
  spEntityId: z.string().min(1).max(2048),
  acsUrl: z.url({ protocol: /^https?$/ }),
  /** This provider's single logout address at the cell's gateway. */
  sloUrl: z.url({ protocol: /^https?$/ }),
};

/**
 * The cell's SAML service provider metadata (spec 55.5), generated by @node-saml: the entity
 * id, the assertion consumer, the single logout address given, and the SP certificates
 * (signing: both during a rotation; encryption: the current). Absent a key pair, metadata
 * without certificates: requests are then unsigned and assertions cannot be encrypted.
 */
export const readServiceProviderMetadata = defineContract({
  service: 'credential', name: 'readServiceProviderMetadata', method: 'POST', path: '/v1/saml/service-provider-metadata',
  callers: ['auth'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ ...spEndpoints, sloUrl: spEndpoints.sloUrl.optional() }),
  response: z.object({ xml: z.string(), signed: z.boolean() }),
});

/** SP-initiated single logout: the provider's single logout address with a signed LogoutRequest for this session. */
export const startSamlLogout = defineContract({
  service: 'credential', name: 'startSamlLogout', method: 'POST', path: '/v1/identity-providers/:providerId/logouts',
  callers: ['auth'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  body: z.strictObject({
    ...spEndpoints,
    nameId: z.string().min(1).max(512), nameIdFormat: z.string().min(1).max(200).optional(), sessionIndex: z.string().min(1).max(512).optional(),
    relayState: z.string().regex(/^[A-Za-z0-9_.-]{16,200}$/),
  }),
  /** Null where the provider declares no single logout address: the session ends at Silo only. */
  response: z.object({ redirectUrl: z.url({ protocol: /^https?$/ }).nullable() }),
});

/**
 * A logout message from the provider, verified (its signature by the provider's certificates,
 * its issuer and destination, by @node-saml): a LogoutRequest (IdP-initiated: whose sessions
 * end, and the LogoutResponse to send the browser back with) or the LogoutResponse to ours.
 */
export const receiveSamlLogout = defineContract({
  service: 'credential', name: 'receiveSamlLogout', method: 'POST', path: '/v1/identity-providers/:providerId/logout-messages',
  callers: ['auth'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ providerId: z.uuid() }),
  body: z.strictObject({
    ...spEndpoints,
    message: z.discriminatedUnion('binding', [
      /** HTTP-Redirect: the query string as received, signature and all. */
      z.strictObject({ binding: z.literal('redirect'), query: z.string().min(1).max(64_000) }),
      z.strictObject({ binding: z.literal('post'), samlRequest: z.string().max(512_000).optional(), samlResponse: z.string().max(512_000).optional(), relayState: z.string().max(200).optional() }),
    ]),
  }),
  response: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('request'), nameId: z.string(), sessionIndex: z.string().nullable(), responseUrl: z.url({ protocol: /^https?$/ }) }),
    z.object({ kind: z.literal('response'), success: z.boolean() }),
  ]),
  maxBodyBytes: 600_000,
});
