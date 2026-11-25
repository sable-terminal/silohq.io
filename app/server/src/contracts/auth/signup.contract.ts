// Self-serve sign-up (decision 2026-11-14; D78): Standard and Business. Enterprise stays on
// contract. The directory places the sign-up in a cell of the chosen residency; there the
// person gives their address and the organisation, verifies the address through the emailed
// link, and completing it creates the organisation with them as its founding super admin,
// signs them in, and starts the subscription in the payment provider's checkout.

import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../utils/password.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { client, sessionView } from './session.contract.ts';

export const SIGNUP_HOURS = 24;

/**
 * Starts a sign-up: the verification email goes to the address. The answer is the same
 * whether or not the address has an account; a slug already taken is refused (slugs are
 * public, in every URL).
 */
export const startSignup = defineContract({
  service: 'auth', name: 'startSignup', method: 'POST', path: '/v1/signups', callers: ['gateway'],
  // Each call sends a fresh link; the earlier one still works until it expires.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    email: z.string().max(320).trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address'),
    organisationName: z.string().trim().min(1).max(200),
    organisationSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    plan: z.enum(['standard', 'business']),
    term: z.enum(['monthly', 'annual']),
    seats: z.number().int().min(1).max(499),
    client: client.optional(),
  }),
  response: z.object({ expiresAt: z.iso.datetime({ offset: true }) }),
  status: 202,
  maxBodyBytes: 2048,
});

/**
 * Completes it with the emailed link's token: a new person chooses a password and gives
 * their name; a person who already has an account proves it with their current password.
 * Answers with the founder's session, and the checkout link (null where it could not be
 * started; billing's own route starts it again).
 */
export const completeSignup = defineContract({
  service: 'auth', name: 'completeSignup', method: 'POST', path: '/v1/signups/complete', callers: ['gateway'],
  // The token works once: a repeat is refused as invalid.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    token: z.string().min(1).max(200),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    timeZone: z.string().min(1).max(64).optional(),
    client: client.optional(),
  }),
  response: sessionView.extend({ sessionToken: z.string(), checkoutUrl: z.url().nullable() }),
  status: 201,
  maxBodyBytes: 2048,
});
