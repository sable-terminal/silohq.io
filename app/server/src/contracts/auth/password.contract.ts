// Password resets (spec 55.3): single use, 30 minutes by default, and consuming one
// revokes every session of the person in the same transaction. A request answers the
// same whether or not the address belongs to anyone, so it reveals nothing.

import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../utils/password.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { client } from './session.contract.ts';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const requestPasswordReset = defineContract({
  service: 'auth', name: 'requestPasswordReset', method: 'POST', path: '/v1/password-resets', callers: ['gateway'],
  // A repeated request issues another single-use link; rate limited per address.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ organisationSlug: slug, email: z.email().max(320), client: client.optional() }),
  response: z.object({ accepted: z.literal(true) }),
  status: 202,
  maxBodyBytes: 2048,
});

export const resetPassword = defineContract({
  service: 'auth', name: 'resetPassword', method: 'POST', path: '/v1/password-resets/consume', callers: ['gateway'],
  // The token is single use, so a retry after success fails rather than repeats.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationSlug: slug,
    token: z.string().regex(/^silo_rst_[A-Za-z0-9_-]{43}$/, 'must be a reset token'),
    newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  }),
  response: z.undefined(),
  maxBodyBytes: 4096,
});
