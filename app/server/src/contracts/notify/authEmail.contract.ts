// The one email that must carry a secret: a password reset link or an invitation link
// (spec 55.3, 55.6). auth issues the token, keeps only its hash, and hands the token here
// for that one email. notify renders the link, gives the message to the cell's mail relay
// and forgets it: the token is never stored, logged or put on a bus.

import { z } from 'zod';
import { tokenKind } from '../../utils/token.util.ts';
import { defineContract } from '../endpoint.contract.ts';

const email = z.email().max(320);
const expiresAt = z.iso.datetime({ offset: true });
const tokenOf = (kind: 'password_reset' | 'invitation' | 'signup') =>
  z.string().max(200).refine((token) => tokenKind(token) === kind, `must be a ${kind} token`);

export const sendAuthEmail = defineContract({
  service: 'notify', name: 'sendAuthEmail', method: 'POST', path: '/v1/auth-emails', callers: ['auth'],
  // A repeat sends the same link again, which the recipient may use once; nothing is stored.
  context: 'organisation', idempotency: 'none',
  body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('password_reset'), to: email, token: tokenOf('password_reset'), expiresAt }),
    z.strictObject({ kind: z.literal('invitation'), to: email, token: tokenOf('invitation'), expiresAt, invitationId: z.uuid() }),
  ]),
  response: z.undefined(),
  maxBodyBytes: 4096,
});

/**
 * A self-serve sign-up's verification link (decision 2026-11-14). There is no organisation
 * yet, so it carries the name the person gave it; the link verifies the address and
 * completes the sign-up once.
 */
export const sendSignupEmail = defineContract({
  service: 'notify', name: 'sendSignupEmail', method: 'POST', path: '/v1/signup-emails', callers: ['auth'],
  // A repeat sends the same link again, which the recipient may use once; nothing is stored.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ to: email, token: tokenOf('signup'), expiresAt, organisationName: z.string().min(1).max(200) }),
  response: z.undefined(),
  maxBodyBytes: 4096,
});
