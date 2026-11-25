// Self-serve sign-up at the cell's public edge (decision 2026-11-14): no session to start or
// complete one; completing it sets the founder's session cookie.

import { startSignup as start, completeSignup as complete } from '../auth/signup.contract.ts';
import { sessionView } from '../auth/session.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';
import { clientOf, viewOf } from './sessions.contract.ts';
import { z } from 'zod';

export const startSignup = definePublicRoute({
  name: 'startSignup', method: 'POST', path: '/signups', session: 'none',
  body: start.body.omit({ client: true }),
  response: start.response,
  status: 202,
  forwards: start,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: (output) => output,
});

export const completeSignup = definePublicRoute({
  name: 'completeSignup', method: 'POST', path: '/signups/complete', session: 'none',
  body: complete.body.omit({ client: true }),
  response: sessionView.extend({ checkoutUrl: z.url().nullable() }),
  status: 201,
  forwards: complete,
  call: (input, ctx) => ({ body: { ...input.body, client: clientOf(ctx.client) } }),
  reply: ({ checkoutUrl, ...output }) => ({ ...viewOf(output), checkoutUrl }),
  establishes: (output) => ({ token: output.sessionToken, absoluteExpiresAt: output.absoluteExpiresAt }),
});

export const SIGNUP_ROUTES = [startSignup, completeSignup] as const;
