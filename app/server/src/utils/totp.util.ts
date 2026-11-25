// Time-based one-time passwords (RFC 6238) for MFA factors of kind totp (spec 55.4). The
// spec fixes no parameters; these are the RFC defaults every authenticator app supports:
// HMAC-SHA-1, 6 digits, 30-second steps, one step of drift either side.
//
// The secret is sealed under the envelope scheme (envelope.util.ts) and opened through
// the credential service with reason mfa_verify; this module only computes codes.
//
// One step of drift either way is accepted, and a code is refused once used within its
// window (decision 2026-10-29). verifyTotp returns the step that matched; the caller
// records it in iam.mfa_factors.last_used_step with a compare-and-set
// (update ... where last_used_step is null or last_used_step < $step), so two logins
// racing with the same code cannot both succeed.

import { createHmac } from 'node:crypto';
import { constantTimeEqual, randomBytes } from './crypto.util.ts';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new TypeError('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

// HOTP (RFC 4226) for one step.
export function totpCode(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

// The matching step within the drift window, or undefined. A step at or before
// lastAcceptedStep is refused, so a code works once.
export function verifyTotp(secret: Uint8Array, code: string, options: { atMs?: number; lastAcceptedStep?: number } = {})
  : number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = totpStep(options.atMs);
  const given = Buffer.from(code);
  let matched: number | undefined;
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step += 1) {
    // Compare every step, so timing does not reveal which one matched.
    if (constantTimeEqual(Buffer.from(totpCode(secret, step)), given) && matched === undefined) matched = step;
  }
  if (matched === undefined || (options.lastAcceptedStep !== undefined && matched <= options.lastAcceptedStep)) {
    return undefined;
  }
  return matched;
}

// The otpauth URI an authenticator app scans at enrolment. Shown once, never logged.
export function totpUri(secret: Uint8Array, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
