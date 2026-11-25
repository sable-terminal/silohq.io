// MFA by TOTP (spec 55.4). The secret is generated and sealed by the credential service;
// auth stores the sealed factor and never sees the secret except inside the otpauth URI
// it passes back once for the authenticator to scan.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { sessionToken, sessionView } from './session.contract.ts';

const code = z.string().regex(/^\d{6}$/, 'must be six digits');

export const verifyMfa = defineContract({
  service: 'auth', name: 'verifyMfa', method: 'POST', path: '/v1/sessions/mfa', callers: ['gateway'],
  // A code works once, so a repeated call with the same code fails rather than repeats.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, code }),
  response: sessionView,
  maxBodyBytes: 1024,
});

export const startTotpEnrolment = defineContract({
  service: 'auth', name: 'startTotpEnrolment', method: 'POST', path: '/v1/mfa/totp', callers: ['gateway'],
  // Each call starts a new, unconfirmed factor; unconfirmed factors are never used.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.object({ factorId: z.uuid(), otpauthUri: z.string().startsWith('otpauth://totp/') }),
  maxBodyBytes: 1024,
});

export const confirmTotpEnrolment = defineContract({
  service: 'auth', name: 'confirmTotpEnrolment', method: 'POST', path: '/v1/mfa/totp/confirm', callers: ['gateway'],
  // Confirming a confirmed factor fails: its first code has been used.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, factorId: z.uuid(), code }),
  response: sessionView,
  maxBodyBytes: 1024,
});

/** A factor as its owner sees it: never its secret or credential. */
export const mfaFactorView = z.object({
  id: z.uuid(),
  kind: z.enum(['totp', 'webauthn']),
  confirmedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const listMfaFactors = defineContract({
  service: 'auth', name: 'listMfaFactors', method: 'POST', path: '/v1/mfa/factors/list', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.object({ factors: z.array(mfaFactorView) }),
  maxBodyBytes: 1024,
});

const identityView = z.object({
  id: z.uuid(),
  identityProviderId: z.uuid(),
  providerKind: z.enum(['saml', 'oidc']),
  issuer: z.string(),
  linkedVia: z.enum(['invitation', 'jit', 'existing_session']),
  linkedAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
const identitiesView = z.object({
  identities: z.array(identityView),
  /** Whether the person can also sign in with a password. */
  password: z.boolean(),
  /** Whether the organisation enforces SSO: then no identity of it can be unlinked. */
  ssoRequired: z.boolean(),
});

/** The person's sign-in identities in the session's organisation. */
export const listIdentities = defineContract({
  service: 'auth', name: 'listIdentities', method: 'POST', path: '/v1/identities/list', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: identitiesView,
  maxBodyBytes: 1024,
});

/**
 * Unlinks one of the person's identities (decision 2026-11-14): only while another way to
 * sign in remains (a password, or another live identity in the organisation), never while
 * the organisation enforces SSO, and always audited (identity_unlinked).
 */
export const unlinkIdentity = defineContract({
  service: 'auth', name: 'unlinkIdentity', method: 'POST', path: '/v1/identities/unlink', callers: ['gateway'],
  // Unlinking an unlinked identity is refused as not found.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, identityId: z.uuid() }),
  response: identitiesView,
  maxBodyBytes: 1024,
});

/**
 * Removes one of the person's factors. A confirmed one needs a session that verified a
 * second factor; the last confirmed one stays while the organisation requires MFA.
 */
export const removeMfaFactor = defineContract({
  service: 'auth', name: 'removeMfaFactor', method: 'POST', path: '/v1/mfa/factors/remove', callers: ['gateway'],
  // Removing a removed factor is refused as not found.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, factorId: z.uuid() }),
  response: z.object({ factors: z.array(mfaFactorView) }),
  maxBodyBytes: 1024,
});
