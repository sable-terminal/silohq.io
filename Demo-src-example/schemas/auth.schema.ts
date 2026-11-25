import { z } from 'zod';
import { email, loginRequest, password, registerRequest, uuid } from '../utils/schemas.util';

/**
 * The shapes the auth endpoints accept.
 *
 * BUILT ON `utils/schemas`, NOT BESIDE IT. `email` lowercases and trims, and it
 * has to be the same `email` everywhere — registration storing a trimmed address
 * while login looks up an untrimmed one is a user who cannot sign in to the
 * account they just made, and neither side looks wrong on its own.
 *
 * `.strict()` ON EVERY OBJECT. A payload with an unexpected field is rejected
 * rather than quietly ignored, so a client sending `{ role: 'admin' }` at an
 * endpoint that does not take a role hears about it instead of assuming it
 * worked. It also catches the renamed field that would otherwise silently become
 * a default.
 */

/**
 * The Turnstile token, on every schema a public form posts to.
 *
 * IT HAS TO BE DECLARED BECAUSE EVERY OBJECT HERE IS `.strict()`. An unexpected
 * key is rejected — which is the behaviour we want for `{ role: 'admin' }` and
 * exactly wrong for the field the bot check needs. Adding the widget without
 * this would make every signup fail validation, and the message would be about
 * a field the person cannot see.
 *
 * OPTIONAL, because the middleware decides whether it is required. When no
 * secret is configured the widget renders nothing and sends nothing.
 */
const turnstileToken = z.string().max(4096).optional();

export const login = loginRequest.extend({ turnstileToken });
export const register = registerRequest.extend({ turnstileToken });

export const chooseOrganisation = z.object({ membershipId: uuid }).strict();

export const changePassword = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: password,
  })
  .strict();

export const requestReset = z.object({ email, turnstileToken }).strict();

export const consumeReset = z
  .object({
    // Not a uuid: reset tokens are opaque random strings, and only their hash is
    // stored. Bounded so an oversized body cannot be forced through the hash.
    token: z.string().min(20).max(500),
    newPassword: password,
    turnstileToken,
  })
  .strict();

/** RFC 6238: six digits. Kept as a string so a leading zero survives. */
export const totpCode = z.string().regex(/^\d{6}$/, 'Enter the six-digit code.');

export const confirmMfa = z.object({ factorId: uuid, code: totpCode }).strict();
export const satisfyMfa = z.object({ code: totpCode }).strict();

export type LoginBody = z.infer<typeof login>;
export type RegisterBody = z.infer<typeof register>;
export type ChooseOrganisationBody = z.infer<typeof chooseOrganisation>;
export type ChangePasswordBody = z.infer<typeof changePassword>;
export type RequestResetBody = z.infer<typeof requestReset>;
export type ConsumeResetBody = z.infer<typeof consumeReset>;
export type ConfirmMfaBody = z.infer<typeof confirmMfa>;
export type SatisfyMfaBody = z.infer<typeof satisfyMfa>;

export const createOrganisation = z
  .object({ name: z.string().min(1).max(200).trim() })
  .strict();

/** One of this person's own sessions. */
export const sessionId = z.object({ id: z.string().uuid() }).strict();
