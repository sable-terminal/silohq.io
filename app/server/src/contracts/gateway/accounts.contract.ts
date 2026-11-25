// Password resets and invitations (spec 55.3, 55.6). Requesting and consuming a reset and
// accepting an invitation need no session; inviting someone is a member's request,
// authorised by the policy service for member.invite at the scope the person joins, and
// keyed, so a retried click sends one invitation.

import { z } from 'zod';
import { acceptInvitation as accept, createInvitation as invite } from '../auth/invitation.contract.ts';
import { requestPasswordReset as requestReset, resetPassword as consumeReset } from '../auth/password.contract.ts';
import { sessionView } from '../auth/session.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';
import { clientOf, viewOf } from './sessions.contract.ts';

export const requestPasswordReset = definePublicRoute({
  name: 'requestPasswordReset', method: 'POST', path: '/password-resets', session: 'none',
  body: requestReset.body.omit({ client: true }),
  response: requestReset.response,
  status: 202,
  forwards: requestReset,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => output,
});

export const resetPassword = definePublicRoute({
  name: 'resetPassword', method: 'POST', path: '/password-resets/consume', session: 'none',
  body: consumeReset.body,
  response: z.undefined(),
  forwards: consumeReset,
  call: (input) => ({ body: input.body }),
  reply: () => undefined,
});

export const createInvitation = definePublicRoute({
  name: 'createInvitation', method: 'POST', path: '/invitations', session: 'complete',
  permission: { permission: 'member.invite', scopeId: (input) => input.body.scopeId },
  body: invite.body,
  response: invite.response,
  status: 201,
  forwards: invite,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const acceptInvitation = definePublicRoute({
  name: 'acceptInvitation', method: 'POST', path: '/invitations/accept', session: 'none',
  body: accept.body.omit({ client: true }),
  response: sessionView,
  status: 201,
  forwards: accept,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => viewOf(output),
  establishes: (output) => ({ token: output.sessionToken, absoluteExpiresAt: output.absoluteExpiresAt }),
});
