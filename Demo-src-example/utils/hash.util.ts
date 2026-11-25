import argon2 from 'argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Every one-way transformation in the system, and the reason each is different.
 *
 * THREE JOBS, THREE ALGORITHMS, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   Passwords    Argon2id. Deliberately slow and memory-hard, because the threat
 *                is an attacker with the hashes and a graphics card.
 *   Tokens       SHA-256. A session token is 256 bits of randomness already, so
 *                there is nothing to brute force and slowness buys nothing —
 *                it would only make every authenticated request cost 100ms.
 *   IP and UA    HMAC-SHA256 with a secret. Plain SHA-256 of an IPv4 address is
 *                reversible by exhausting all four billion of them on a laptop.
 *
 * Using the password function for tokens is the mistake that looks careful.
 */

/**
 * Argon2id parameters.
 *
 * `type: argon2id` rather than `argon2i` or `argon2d`. It is the hybrid, and the
 * one the RFC recommends when you do not have a specific reason to want another:
 * it resists both side-channel and GPU attacks rather than one or the other.
 *
 * 19 MiB and 2 passes is the OWASP baseline. Memory is the parameter that costs
 * an attacker most, because it is what makes a GPU's thousands of cores useless
 * — each one would need its own 19 MiB.
 *
 * THE PARAMETERS ARE STORED IN THE HASH, which is why `verify` needs no
 * configuration and why raising these later does not lock anybody out. Old hashes
 * verify under their own settings, and `needsRehash` says when to upgrade one.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * A NULL HASH IS ALWAYS A FAILURE, AND NEVER AN ERROR. An SSO-only membership has
 * no password hash, and the row is legitimate. The danger is a verifier that
 * treats "nothing to compare against" as anything other than a refusal — so it is
 * handled here, once, rather than left to every caller to remember.
 *
 * IT DOES NOT SAY WHY IT FAILED. Distinguishing "no such user" from "wrong
 * password" hands an attacker a user-enumeration oracle, and the caller has no
 * legitimate use for the difference.
 */
export async function verifyPassword(hash: string | null, plaintext: string): Promise<boolean> {
  if (!hash) {
    /*
     * A DUMMY VERIFY, NOT AN EARLY RETURN. Returning immediately makes the
     * no-password case measurably faster than the wrong-password case, and that
     * timing difference tells an attacker which addresses have passwords. This
     * burns the same ~50ms and discards the result.
     */
    await argon2.verify(await dummyHash(), plaintext).catch(() => false);
    return false;
  }

  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // A malformed hash in the column. Not a match, and not a crash on the login
    // path — but the caller should never see a difference from a wrong password.
    return false;
  }
}

/**
 * A real Argon2id hash of a value nobody knows, used only to spend time.
 *
 * COMPUTED ONCE, LAZILY, AND CACHED. Hashing a fresh dummy per failed login would
 * double the cost of the thing it exists to make constant. Lazily rather than at
 * module load because this module is imported by things that never verify a
 * password — a migration script should not spend 50ms of Argon2 to start.
 */
let dummy: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummy ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return dummy;
}

/**
 * Whether a stored hash was made with weaker parameters than the current ones.
 *
 * Checked on successful login, when the plaintext is in hand and can be rehashed.
 * It is the only moment it can be, which is why raising the parameters has to be
 * paired with this rather than done alone.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    // Unparseable, so it certainly is not current.
    return true;
  }
}

/**
 * Hash a token for storage.
 *
 * THE PLAINTEXT NEVER TOUCHES THE DATABASE. A session token, an invitation token
 * and a password reset are all bearer credentials: whoever holds one is the user.
 * Storing them means a database backup is a set of live logins. What is stored is
 * this hash, and the lookup hashes the presented token and compares.
 *
 * SHA-256 AND NOT ARGON2, DELIBERATELY. These tokens are 256 bits of randomness
 * from a CSPRNG, so there is no dictionary to run and no work factor to buy.
 * Argon2 here would add 50ms to every authenticated request for nothing.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Hash an IP address or user agent for an audit row.
 *
 * KEYED, BECAUSE THE INPUT SPACE IS SMALL. There are about four billion IPv4
 * addresses; a plain SHA-256 of one is reversible by computing all of them,
 * which takes minutes. An HMAC under a secret the attacker does not have is not.
 *
 * The point is to be able to say "these two events came from the same place"
 * without storing where that was.
 */
export function hashIdentifier(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Compare two hex digests without leaking how far they matched.
 *
 * `===` ON A SECRET IS A TIMING ORACLE. String comparison returns at the first
 * differing byte, so an attacker measuring response time learns the length of the
 * matching prefix and can recover a token one character at a time.
 *
 * LENGTH IS CHECKED FIRST BECAUSE `timingSafeEqual` THROWS ON A MISMATCH, and a
 * thrown exception is a much louder timing signal than the comparison it was
 * meant to protect. Different lengths are not equal, which is not a secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
