// A person's own memberships and factors, and the API client token exchange (spec 55.4,
// 60.2, 60.5).
//
// The person's routes take the session from the cookie, as the MFA routes do; the auth
// service resolves it and applies its own rules (switching needs any second factor
// verified first; removing a confirmed factor needs one verified). Switching establishes a
// new session, so the gateway sets the cookie and the old session ends.
//
// The token exchange is for an API client's server, never a browser: no session, no
// browser rules, a request carrying browser fetch metadata refused. The access token it
// returns is sent as a bearer token on the routes the policy service decides.

import { issueClientSession } from '../auth/clientSession.contract.ts';
import {
  listIdentities as listLinked, listMfaFactors as listFactors, removeMfaFactor as removeFactor, unlinkIdentity as unlink,
} from '../auth/mfa.contract.ts';
import { listMyMemberships as listMemberships, readOwnProfile as ownProfile, sessionView, switchMembership as switchTo } from '../auth/session.contract.ts';
import { listDirectory as directory } from '../policy/admin.contract.ts';
import { listMyPermissions as myPermissions, listPermittedScopes as permittedScopes } from '../policy/decision.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';
import { clientOf } from './sessions.contract.ts';
import { z } from 'zod';

/** The signed-in person: their name and email, for the identity menu. */
export const readOwnProfile = definePublicRoute({
  name: 'readOwnProfile', method: 'GET', path: '/session/person', session: 'mfa_pending',
  response: ownProfile.response,
  forwards: ownProfile,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

export const listMyMemberships = definePublicRoute({
  name: 'listMyMemberships', method: 'GET', path: '/session/memberships', session: 'mfa_pending',
  response: listMemberships.response,
  forwards: listMemberships,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

export const switchMembership = definePublicRoute({
  name: 'switchMembership', method: 'POST', path: '/session/membership', session: 'mfa_pending',
  body: z.strictObject({ organisationId: z.uuid() }),
  response: sessionView,
  status: 201,
  forwards: switchTo,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, organisationId: input.body.organisationId, client: clientOf(ctx.client) } }),
  reply: ({ sessionToken: _token, ...view }) => view,
  establishes: (output) => ({ token: output.sessionToken, absoluteExpiresAt: output.absoluteExpiresAt }),
});

export const listMfaFactors = definePublicRoute({
  name: 'listMfaFactors', method: 'GET', path: '/mfa/factors', session: 'mfa_pending',
  response: listFactors.response,
  forwards: listFactors,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

export const removeMfaFactor = definePublicRoute({
  name: 'removeMfaFactor', method: 'POST', path: '/mfa/factors/:factorId/removal', session: 'mfa_pending',
  params: z.strictObject({ factorId: z.uuid() }),
  response: removeFactor.response,
  forwards: removeFactor,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, factorId: input.params.factorId } }),
  reply: (output) => output,
});

/** The person's sign-in identities in the active organisation. */
export const listIdentities = definePublicRoute({
  name: 'listIdentities', method: 'GET', path: '/identities', session: 'mfa_pending',
  response: listLinked.response,
  forwards: listLinked,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

/**
 * Unlinks one (decision 2026-11-14): auth refuses the last way to sign in, any while SSO is
 * enforced, and a session that has not verified the person's second factor.
 */
export const unlinkIdentity = definePublicRoute({
  name: 'unlinkIdentity', method: 'POST', path: '/identities/:identityId/unlinking', session: 'mfa_pending',
  params: z.strictObject({ identityId: z.uuid() }),
  response: unlink.response,
  forwards: unlink,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, identityId: input.params.identityId } }),
  reply: (output) => output,
});

export const issueApiClientSession = definePublicRoute({
  name: 'issueApiClientSession', method: 'POST', path: '/api-clients/sessions', session: 'none', apiClient: true,
  body: issueClientSession.body.omit({ client: true }),
  response: issueClientSession.response,
  status: 201,
  forwards: issueClientSession,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => output,
});

/** Where the signed-in member holds a scoped permission (W7): the scopes a form offers, such as a new connection's owner. */
export const listMyPermittedScopes = definePublicRoute({
  name: 'listMyPermittedScopes', method: 'GET', path: '/session/permitted-scopes', session: 'complete', ownRecords: true,
  query: z.strictObject({ permission: permittedScopes.body.shape.permission }),
  response: permittedScopes.response,
  forwards: permittedScopes,
  call: (input) => ({ body: { permission: input.query.permission } }),
  reply: (output) => output,
});

/** Every permission and where the signed-in member holds it: the client disables what they cannot use and names what it needs (spec 33.3). */
export const readMyPermissions = definePublicRoute({
  name: 'readMyPermissions', method: 'GET', path: '/session/permissions', session: 'complete', ownRecords: true,
  response: myPermissions.response,
  forwards: myPermissions,
  call: () => ({}),
  reply: (output) => output,
});

/** The organisation's members by name and its scopes, for sharing and for naming who did something. */
export const readDirectory = definePublicRoute({
  name: 'readDirectory', method: 'GET', path: '/directory', session: 'complete',
  decidedByService: 'every member of the organisation may see who else is in it, by name, and its scopes: sharing names them (spec 56); policy gives names and states only',
  response: directory.response,
  forwards: directory,
  call: () => ({}),
  reply: (output) => output,
});

export const ACCOUNT_ROUTES = [
  readOwnProfile,
  listMyMemberships, listMyPermittedScopes, readMyPermissions, readDirectory, switchMembership, listMfaFactors, removeMfaFactor, listIdentities, unlinkIdentity, issueApiClientSession,
] as const;
