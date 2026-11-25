// WebAuthn as an MFA factor (spec 55.4; design: iam.mfa_factors credential_id,
// webauthn_public_key, sign_count), and changing a password while signed in (spec 55.3).
//
// The ceremonies are @simplewebauthn/server's: auth issues the options with a challenge,
// kept in redis-data for the session and used once, and verifies the browser's answer
// against it, the relying party (the public origin's host) and the origin. A factor is
// confirmed by its registration; an assertion moves its signature counter forward or is
// refused as a possible clone. Enrolling follows the TOTP rule: no confirmed factor yet,
// or MFA already satisfied in this session.

import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../utils/password.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { sessionToken, sessionView } from './session.contract.ts';

const b64url = (max: number) => z.string().regex(/^[A-Za-z0-9_-]*$/).max(max);

/** The options the browser hands to navigator.credentials, as the library builds them. */
export const webauthnOptions = z.looseObject({ challenge: b64url(128) });

/** The browser's answer to a registration (RegistrationResponseJSON). */
export const registrationResponse = z.looseObject({
  id: b64url(1024),
  rawId: b64url(1024),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64url(16_384),
    attestationObject: b64url(65_536),
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
});

/** The browser's answer to an assertion (AuthenticationResponseJSON). */
export const authenticationResponse = z.looseObject({
  id: b64url(1024),
  rawId: b64url(1024),
  type: z.literal('public-key'),
  response: z.looseObject({
    clientDataJSON: b64url(16_384),
    authenticatorData: b64url(16_384),
    signature: b64url(1024),
    userHandle: b64url(1024).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).optional(),
});

export const startWebauthnRegistration = defineContract({
  service: 'auth', name: 'startWebauthnRegistration', method: 'POST', path: '/v1/mfa/webauthn/registrations', callers: ['gateway'],
  // A new challenge each call; the last one is the one that counts.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.object({ options: webauthnOptions }),
  status: 201,
  maxBodyBytes: 1024,
});

export const confirmWebauthnRegistration = defineContract({
  service: 'auth', name: 'confirmWebauthnRegistration', method: 'POST', path: '/v1/mfa/webauthn/registrations/confirm', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, response: registrationResponse }),
  response: sessionView,
  maxBodyBytes: 131_072,
});

export const startWebauthnAssertion = defineContract({
  service: 'auth', name: 'startWebauthnAssertion', method: 'POST', path: '/v1/mfa/webauthn/assertions', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.object({ options: webauthnOptions }),
  status: 201,
  maxBodyBytes: 1024,
});

export const verifyWebauthnAssertion = defineContract({
  service: 'auth', name: 'verifyWebauthnAssertion', method: 'POST', path: '/v1/mfa/webauthn/assertions/verify', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, response: authenticationResponse }),
  response: sessionView,
  maxBodyBytes: 65_536,
});

export const changePassword = defineContract({
  service: 'auth', name: 'changePassword', method: 'POST', path: '/v1/passwords/changes', callers: ['gateway'],
  // The signed-in person, with their current password; every other session of theirs is
  // revoked, this one kept. The gateway sends it only for a complete session, with that
  // session's context.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  }),
  response: z.object({ otherSessionsRevoked: z.number().int().min(0) }),
  maxBodyBytes: 4096,
});
