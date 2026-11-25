import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { actAsUser, withoutTenant } from '../infra/db.infra';
import { runUntenanted } from '../utils/tenantContext.util';
import { denial, invalid } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { seal } from '../utils/envelope.util';
import { withSecret } from '../utils/mediator.util';
import { secretAccessLog } from '../utils/credentialAudit.util';
import { wrapper } from '../infra/kms.infra';
import { secretPurpose } from '../models/mfa.model';
import * as mfaRepo from '../repos/mfa.repo';
import * as sessionRepo from '../repos/session.repo';

/**
 * Time-based one-time passwords.
 *
 * RFC 6238 IN THIRTY LINES RATHER THAN A DEPENDENCY. TOTP is an HMAC of a
 * counter, truncated — the whole algorithm is below. A library would bring QR
 * generation, base32 helpers and its own opinions about storage, for something
 * whose entire security rests on two decisions this file has to make anyway: how
 * the secret is stored, and how wide the acceptance window is.
 *
 * THE SECRET IS SEALED UNDER THE SAME ENVELOPE AS A CONNECTOR CREDENTIAL. A TOTP
 * secret is a bearer credential: anybody holding it generates valid codes
 * forever, and a database dump containing them is a database dump containing
 * everybody's second factor.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * One step either side of now.
 *
 * WIDER WOULD BE KINDER AND IS WRONG. Each extra step multiplies the codes valid
 * at any moment, and a code is only six digits. One step tolerates the clock
 * skew and typing delay that actually happen; three would be a 90-second window
 * in which a shoulder-surfed code still works.
 */
const WINDOW_STEPS = 1;

/** RFC 4648 base32, which is what every authenticator app expects. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');

  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function decodeBase32(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw invalid({ message: 'Malformed secret.', code: 'invalid.totp_secret' });
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The code for one time step. */
export function codeFor(secret: string, counter: number): string {
  const key = decodeBase32(secret);

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(buffer).digest();
  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks
  // where to read four bytes from.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Verify a code.
 *
 * CONSTANT-TIME COMPARISON, EVEN THOUGH IT IS SIX DIGITS. The window means
 * several codes are valid, and a timing difference across the loop would reveal
 * which step matched — narrowing an attacker's search from a million to a
 * hundred thousand and telling them the victim's clock offset.
 */
export function verifyCode(secret: string, code: string, now = new Date()): boolean {
  const presented = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(presented)) return false;

  const counter = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
  let matched = false;

  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step++) {
    const expected = Buffer.from(codeFor(secret, counter + step), 'utf8');
    const given = Buffer.from(presented, 'utf8');
    // Every step is evaluated: an early return would leak which one matched.
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }

  return matched;
}

/** The URI an authenticator app scans. */
export function enrolmentUri(secret: string, email: string, issuer = 'Silo'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Begin enrolment.
 *
 * THE FACTOR IS STORED UNCONFIRMED AND CANNOT SATISFY ANYTHING. Somebody who
 * starts enrolling and abandons it has a row in the table; treating that as a
 * factor would let a user appear to have MFA they never finished setting up —
 * and then be locked out by an organisation that requires it.
 */
export async function beginEnrolment(input: {
  userId: string;
  email: string;
}): Promise<{ secret: string; uri: string; factorId: string }> {
  const secret = generateSecret();
  const factorId = generateId();

  await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      // `mfa_factors_own` governs all four of these blocks.
      await actAsUser(db, input.userId);
      await mfaRepo.createTotp(db, {
        id: factorId,
        userId: input.userId,
        secret: await seal(secret, wrapper(), secretPurpose(factorId)),
      });
    }),
  );

  return { secret, uri: enrolmentUri(secret, input.email), factorId };
}

/**
 * Confirm enrolment with a code from the app.
 *
 * CONFIRMATION PROVES THE SECRET ARRIVED. Without it, a mistyped or truncated
 * secret is stored, the user is told MFA is on, and they are locked out at the
 * next login with no way back.
 */
export async function confirmEnrolment(input: {
  userId: string;
  factorId: string;
  code: string;
}): Promise<boolean> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      await actAsUser(db, input.userId);
      const factor = await mfaRepo.findUnconfirmedTotp(db, {
        factorId: input.factorId,
        userId: input.userId,
      });

      if (!factor) return false;

      /*
       * §14.4 — THROUGH THE MEDIATOR, like every other secret. This used to
       * call `unseal` directly, which made "single mediator for plaintext
       * access" untrue and meant a tampered factor left no trace at all.
       */
      const ok = await withSecret(
        factor.secret,
        { wrapper: wrapper(), log: secretAccessLog(null) },
        { reason: 'mfa-verify', subject: factor.id, additionalData: secretPurpose(factor.id) },
        async (secret) => verifyCode(secret, input.code),
      );

      if (!ok) return false;

      await mfaRepo.markConfirmed(db, factor.id);
      return true;
    }),
  );
}

/**
 * Satisfy MFA for a session.
 *
 * IT MARKS THE SESSION, NOT THE USER. A person may be signed in on two devices
 * and must prove the second factor on each — marking the user would mean
 * satisfying MFA on a trusted laptop silently authorises a session somebody else
 * started.
 */
export async function satisfy(input: {
  userId: string;
  sessionId: string;
  code: string;
}): Promise<boolean> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      await actAsUser(db, input.userId);

      for (const factor of await mfaRepo.listConfirmedTotp(db, input.userId)) {
        const matched = await withSecret(
          factor.secret,
          { wrapper: wrapper(), log: secretAccessLog(null) },
          { reason: 'mfa-verify', subject: factor.id, additionalData: secretPurpose(factor.id) },
          async (secret) => verifyCode(secret, input.code),
        );

        if (matched) {
          await sessionRepo.markMfaSatisfied(db, input.sessionId);
          return true;
        }
      }

      return false;
    }),
  );
}

export async function hasConfirmedFactor(userId: string): Promise<boolean> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      await actAsUser(db, userId);
      return (await mfaRepo.countConfirmed(db, userId)) > 0;
    }),
  );
}

export { denial };
