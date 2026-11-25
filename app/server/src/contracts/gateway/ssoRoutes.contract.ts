// Federated sign-in at the edge (spec 55.5): the app's side of the flow in
// contracts/auth/sso.contract.ts, and managing the organisation's providers.
//
// The app starts a flow with a JSON call (so the usual Origin and CSRF rules apply), keeps
// the binding it gets back for the tab, and sends the browser to the provider. It finishes
// with a JSON call too: from its callback page for OIDC, or from its completion page for
// SAML, where the gateway's assertion consumer sent the browser with a ticket (the one
// form post the edge accepts, controllers/gateway/federation.controller.ts). The finishing
// call establishes the session cookie, as signing in with a password does.
//
// Linking the signed-in person's own account acts on their own records only, so it names
// no permission; auth requires their MFA to be complete. Managing providers needs
// org.sso.manage (spec 56: super admin only).

import { addDomain, listDomains, removeDomain, verifyDomain } from '../auth/domain.contract.ts';
import { z } from 'zod';
import {
  completeOidcSignIn, completeSamlSignIn, configureIdentityProvider, listIdentityProviders, listSignInOptions, readIdentityProviderConfig,
  startSso, startSsoLink as startLink,
} from '../auth/sso.contract.ts';
import {
  createScimGroupMapping, issueScimToken, listScimGroups, listScimTokens, removeScimGroupMapping, revokeScimToken,
} from '../auth/scim.contract.ts';
import { sessionView } from '../auth/session.contract.ts';
import {
  changePassword, confirmWebauthnRegistration, startWebauthnAssertion, startWebauthnRegistration, verifyWebauthnAssertion,
} from '../auth/webauthn.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';
import { clientOf, viewOf } from './sessions.contract.ts';

/** The app's pages the flow returns to: the OIDC callback, and SAML's completion page (#ticket= or #error=). */
export const SSO_PAGES = { oidcCallback: '/sso/callback', samlComplete: '/sso/complete' } as const;

export const signInOptions = definePublicRoute({
  name: 'signInOptions', method: 'GET', path: '/sso/options', session: 'none',
  query: listSignInOptions.query,
  response: listSignInOptions.response,
  forwards: listSignInOptions,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const startSignInBySso = definePublicRoute({
  name: 'startSignInBySso', method: 'POST', path: '/sso/start', session: 'none',
  body: startSso.body,
  response: startSso.response,
  status: 201,
  forwards: startSso,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const startSsoLink = definePublicRoute({
  name: 'startSsoLink', method: 'POST', path: '/sso/link', session: 'complete', ownRecords: true,
  body: startLink.body,
  response: startLink.response,
  status: 201,
  forwards: startLink,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const completeOidc = definePublicRoute({
  name: 'completeOidc', method: 'POST', path: '/sso/oidc/complete', session: 'none',
  body: completeOidcSignIn.body.omit({ client: true }),
  response: sessionView,
  status: 201,
  forwards: completeOidcSignIn,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => viewOf(output),
  establishes: (output) => ({ token: output.sessionToken, absoluteExpiresAt: output.absoluteExpiresAt }),
});

export const completeSaml = definePublicRoute({
  name: 'completeSaml', method: 'POST', path: '/sso/saml/complete', session: 'none',
  body: completeSamlSignIn.body.omit({ client: true }),
  response: sessionView,
  status: 201,
  forwards: completeSamlSignIn,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => viewOf(output),
  establishes: (output) => ({ token: output.sessionToken, absoluteExpiresAt: output.absoluteExpiresAt }),
});

export const listProviders = definePublicRoute({
  name: 'listIdentityProviders', method: 'GET', path: '/identity-providers', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  response: listIdentityProviders.response,
  forwards: listIdentityProviders,
  call: () => ({}),
  reply: (output) => output,
});

export const readProvider = definePublicRoute({
  name: 'readIdentityProvider', method: 'GET', path: '/identity-providers/:providerId', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  params: readIdentityProviderConfig.params,
  response: readIdentityProviderConfig.response,
  forwards: readIdentityProviderConfig,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const configureProvider = definePublicRoute({
  name: 'configureIdentityProvider', method: 'PUT', path: '/identity-providers/:providerId', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  params: configureIdentityProvider.params,
  body: configureIdentityProvider.body,
  response: configureIdentityProvider.response,
  forwards: configureIdentityProvider,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

// SCIM tokens for the organisation's provisioning client (spec 55.5): shown once.
export const issueProvisioningToken = definePublicRoute({
  name: 'issueScimToken', method: 'POST', path: '/scim-tokens', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  response: issueScimToken.response,
  status: 201,
  forwards: issueScimToken,
  call: () => ({}),
  reply: (output) => output,
});

export const listProvisioningTokens = definePublicRoute({
  name: 'listScimTokens', method: 'GET', path: '/scim-tokens', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  response: listScimTokens.response,
  forwards: listScimTokens,
  call: () => ({}),
  reply: (output) => output,
});

export const revokeProvisioningToken = definePublicRoute({
  name: 'revokeScimToken', method: 'DELETE', path: '/scim-tokens/:tokenId', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  params: revokeScimToken.params,
  response: z.undefined(),
  forwards: revokeScimToken,
  call: (input) => ({ params: input.params }),
  reply: () => undefined,
});

// The organisation's email domains (decision 2026-11-14): verified through DNS, claimed in the cell.
export const listOrganisationDomains = definePublicRoute({
  name: 'listDomains', method: 'GET', path: '/domains', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  response: listDomains.response,
  forwards: listDomains,
  call: () => ({}),
  reply: (output) => output,
});

export const addOrganisationDomain = definePublicRoute({
  name: 'addDomain', method: 'POST', path: '/domains', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  body: addDomain.body,
  response: addDomain.response,
  status: 201,
  forwards: addDomain,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const verifyOrganisationDomain = definePublicRoute({
  name: 'verifyDomain', method: 'POST', path: '/domains/:domainId/verification', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  params: verifyDomain.params,
  response: verifyDomain.response,
  forwards: verifyDomain,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const removeOrganisationDomain = definePublicRoute({
  name: 'removeDomain', method: 'DELETE', path: '/domains/:domainId', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  params: removeDomain.params,
  response: z.undefined(),
  forwards: removeDomain,
  call: (input) => ({ params: input.params }),
  reply: () => undefined,
});

// SCIM groups and their mappings to roles (decision 2026-11-14): unmapped groups grant nothing.
export const listProvisionedGroups = definePublicRoute({
  name: 'listScimGroups', method: 'GET', path: '/scim-groups', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  response: listScimGroups.response,
  forwards: listScimGroups,
  call: () => ({}),
  reply: (output) => output,
});

export const mapProvisionedGroup = definePublicRoute({
  name: 'createScimGroupMapping', method: 'POST', path: '/scim-group-mappings', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  body: createScimGroupMapping.body,
  response: createScimGroupMapping.response,
  status: 201,
  forwards: createScimGroupMapping,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const unmapProvisionedGroup = definePublicRoute({
  name: 'removeScimGroupMapping', method: 'DELETE', path: '/scim-group-mappings/:mappingId', session: 'complete',
  permission: { permission: 'org.sso.manage' },
  params: removeScimGroupMapping.params,
  response: z.undefined(),
  forwards: removeScimGroupMapping,
  call: (input) => ({ params: input.params }),
  reply: () => undefined,
});

// ----------------------------------------------------------------------------- the account's own security
// WebAuthn ceremonies sit with the TOTP ones: a live session whose MFA may be pending. A
// password change acts on the person's own account: a complete session, no permission.

export const startSecurityKeyRegistration = definePublicRoute({
  name: 'startSecurityKeyRegistration', method: 'POST', path: '/mfa/webauthn', session: 'mfa_pending',
  response: startWebauthnRegistration.response,
  status: 201,
  forwards: startWebauthnRegistration,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

export const confirmSecurityKeyRegistration = definePublicRoute({
  name: 'confirmSecurityKeyRegistration', method: 'POST', path: '/mfa/webauthn/confirm', session: 'mfa_pending',
  body: confirmWebauthnRegistration.body.omit({ sessionToken: true }),
  response: sessionView,
  forwards: confirmWebauthnRegistration,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, response: input.body.response } }),
  reply: (output) => output,
});

export const startSecurityKeyAssertion = definePublicRoute({
  name: 'startSecurityKeyAssertion', method: 'POST', path: '/session/mfa/webauthn', session: 'mfa_pending',
  response: startWebauthnAssertion.response,
  status: 201,
  forwards: startWebauthnAssertion,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

export const verifySecurityKeyAssertion = definePublicRoute({
  name: 'verifySecurityKeyAssertion', method: 'POST', path: '/session/mfa/webauthn/verify', session: 'mfa_pending',
  body: verifyWebauthnAssertion.body.omit({ sessionToken: true }),
  response: sessionView,
  forwards: verifyWebauthnAssertion,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, response: input.body.response } }),
  reply: (output) => output,
});

export const changeOwnPassword = definePublicRoute({
  name: 'changeOwnPassword', method: 'POST', path: '/password', session: 'complete', ownRecords: true,
  body: changePassword.body,
  response: changePassword.response,
  forwards: changePassword,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const SSO_ROUTES = [
  signInOptions, startSignInBySso, startSsoLink, completeOidc, completeSaml, listProviders, readProvider, configureProvider,
  issueProvisioningToken, listProvisioningTokens, revokeProvisioningToken, listProvisionedGroups, mapProvisionedGroup, unmapProvisionedGroup,
  listOrganisationDomains, addOrganisationDomain, verifyOrganisationDomain, removeOrganisationDomain,
  startSecurityKeyRegistration, confirmSecurityKeyRegistration, startSecurityKeyAssertion, verifySecurityKeyAssertion, changeOwnPassword,
] as const;

/** The SAML assertion consumer's form fields, as the edge reads them. */
export const samlPost = z.object({
  SAMLResponse: z.string().min(1).max(512_000),
  RelayState: z.string().min(1).max(200),
});
