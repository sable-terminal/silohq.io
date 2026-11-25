// The credential service's TOTP endpoints (spec 61.3, decision 2026-10-29). auth holds
// the sealed factor (iam.mfa_factors is silo_auth's only, spec 64.5) and sends it here;
// only the credential service unwraps it. The secret leaves in clear exactly once, inside
// the otpauth URI an authenticator scans at enrolment, and never again: verification
// returns the matching time step, not the secret.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const base64 = (min: number, max: number) => z.base64().refine((text) => {
  const bytes = Buffer.from(text, 'base64').length;
  return bytes >= min && bytes <= max;
}, `must be ${min} to ${max} bytes`);

/** A sealed secret as it crosses the wire: the mfa_factors columns, base64. */
export const sealedSecret = z.object({
  secretSealed: base64(16, 4096),
  nonce: base64(12, 12),
  dekWrapped: base64(16, 4096),
  keyVersionId: z.uuid(),
});
export type SealedSecretWire = z.infer<typeof sealedSecret>;

export const enrolTotp = defineContract({
  service: 'credential', name: 'enrolTotp', method: 'POST', path: '/v1/totp/enrolments', callers: ['auth'],
  // A new secret each call and nothing stored here: auth keeps the sealed factor.
  context: 'user', idempotency: 'none',
  body: z.strictObject({
    factorId: z.uuid(),
    accountName: z.string().min(1).max(320),
    issuer: z.string().min(1).max(100),
  }),
  response: z.object({ sealed: sealedSecret, otpauthUri: z.string().startsWith('otpauth://totp/') }),
  maxBodyBytes: 4096,
});

export const verifyTotp = defineContract({
  service: 'credential', name: 'verifyTotp', method: 'POST', path: '/v1/totp/verifications', callers: ['auth'],
  // Checks a code and records the unwrap; auth accepts the step by compare-and-set.
  // The organisation is the one being logged into (the unwrap ledger is tenant-scoped).
  context: 'user', idempotency: 'none',
  body: z.strictObject({
    factorId: z.uuid(),
    sealed: sealedSecret,
    code: z.string().regex(/^\d{6}$/),
    lastUsedStep: z.number().int().min(0).nullable(),
  }),
  response: z.object({ step: z.number().int().min(0).nullable() }),
  maxBodyBytes: 16_384,
});
