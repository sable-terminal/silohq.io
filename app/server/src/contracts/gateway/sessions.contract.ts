// Signing in and out, the current session, and MFA (spec 55.3, 55.4, 60). The browser
// holds the session only as a cookie; the auth service takes the token in the body, so
// the gateway passes the cookie's token and never returns it.

import { z } from 'zod';
import { client, login, revokeSession, sessionView, type SessionView } from '../auth/session.contract.ts';
import { beginSingleLogout } from '../auth/sso.contract.ts';
import { confirmTotpEnrolment as confirmTotp, startTotpEnrolment as startTotp, verifyMfa as verifyCode } from '../auth/mfa.contract.ts';
import { definePublicRoute, type EdgeClient, type EdgeSession } from './publicRoute.contract.ts';

/** The client as the auth service records it: an address that is not an IP address is left out. */
export function clientOf(edge: EdgeClient): z.input<typeof client> {
  const address = client.shape.address.safeParse(edge.address);
  return {
    ...(address.success && address.data !== undefined ? { address: address.data } : {}),
    ...(edge.userAgent ? { userAgent: edge.userAgent.slice(0, 1024) } : {}),
  };
}

/** The session as the browser sees it: everything but the token. */
export function viewOf(session: EdgeSession | (SessionView & { sessionToken: string })): SessionView {
  return {
    sessionId: session.sessionId, userId: session.userId, organisationId: session.organisationId, membershipId: session.membershipId,
    authMethod: session.authMethod, mfa: session.mfa, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt,
  };
}

export const signIn = definePublicRoute({
  name: 'signIn', method: 'POST', path: '/sessions', session: 'none',
  body: login.body.omit({ client: true }),
  response: sessionView,
  status: 201,
  forwards: login,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => viewOf(output),
  establishes: (output) => ({ token: output.sessionToken, absoluteExpiresAt: output.absoluteExpiresAt }),
});

export const currentSession = definePublicRoute({
  name: 'currentSession', method: 'GET', path: '/session', session: 'mfa_pending',
  response: sessionView,
  answer: (_input, ctx) => viewOf(ctx.session),
});

export const signOut = definePublicRoute({
  name: 'signOut', method: 'DELETE', path: '/session', session: 'mfa_pending',
  response: z.undefined(),
  forwards: revokeSession,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: () => undefined,
  ends: true,
});

/**
 * Signing out with single logout (spec 55.5): the session ends, its cookie is cleared, and
 * where it came from a SAML provider with single logout the app sends the browser on to
 * logoutUrl so the provider's session ends too.
 */
export const signOutWithProvider = definePublicRoute({
  name: 'signOutWithProvider', method: 'POST', path: '/session/single-logout', session: 'mfa_pending',
  response: beginSingleLogout.response,
  forwards: beginSingleLogout,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
  ends: true,
});

export const verifyMfa = definePublicRoute({
  name: 'verifyMfa', method: 'POST', path: '/session/mfa', session: 'mfa_pending',
  body: verifyCode.body.omit({ sessionToken: true }),
  response: sessionView,
  forwards: verifyCode,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, code: input.body.code } }),
  reply: (output) => output,
});

export const startTotpEnrolment = definePublicRoute({
  name: 'startTotpEnrolment', method: 'POST', path: '/mfa/totp', session: 'mfa_pending',
  response: startTotp.response,
  status: 201,
  forwards: startTotp,
  call: (_input, ctx) => ({ body: { sessionToken: ctx.session.token } }),
  reply: (output) => output,
});

export const confirmTotpEnrolment = definePublicRoute({
  name: 'confirmTotpEnrolment', method: 'POST', path: '/mfa/totp/confirm', session: 'mfa_pending',
  body: confirmTotp.body.omit({ sessionToken: true }),
  response: sessionView,
  forwards: confirmTotp,
  call: (input, ctx) => ({ body: { sessionToken: ctx.session.token, factorId: input.body.factorId, code: input.body.code } }),
  reply: (output) => output,
});
