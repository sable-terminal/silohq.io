/**
 * One answer to "has this expired".
 *
 * SESSIONS, INVITATIONS, GRANTS, CLEARANCES, APPROVALS AND SHARES ALL EXPIRE, and
 * without a shared helper each gets its own comparison written by whoever needed
 * it that day. They then disagree at the edges — one treats null as never, another
 * as immediately; one is inclusive of the boundary, another is not — and the
 * disagreement surfaces as an access-control bug that only appears on the second
 * of expiry.
 *
 * NULL MEANS NEVER, EVERYWHERE. A grant with no expiry is permanent, a session
 * with none does not exist. The alternative — null meaning "expired" — makes a
 * forgotten column deny access, which is safe and unusable.
 *
 * THE BOUNDARY IS EXCLUSIVE: `expires_at` is the first instant it is no longer
 * valid, so a row expiring at exactly now is expired. Anything else needs a
 * sentence to explain and gets it wrong under a clock skew of one millisecond.
 */

export interface Expirable {
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function hasExpired(expiresAt: Date | string | null | undefined, now = new Date()): boolean {
  const time = toTime(expiresAt);
  if (time === null) return false;
  return time <= now.getTime();
}

/**
 * Whether something is currently usable: not expired and not revoked.
 *
 * REVOCATION AND EXPIRY ARE CHECKED TOGETHER because every caller needs both and
 * a caller that checks only one is a caller that honours a revoked session until
 * its natural expiry. That is the exact failure opaque sessions exist to prevent.
 */
export function isActive(subject: Expirable, now = new Date()): boolean {
  if (toTime(subject.revokedAt) !== null) return false;
  return !hasExpired(subject.expiresAt, now);
}

/** A timestamp `seconds` from now, for setting an expiry. */
export function expiresIn(seconds: number, from = new Date()): Date {
  return new Date(from.getTime() + seconds * 1000);
}

/**
 * How long is left, in seconds, floored at zero.
 *
 * Never negative: a caller putting this in a `Max-Age` or a `Retry-After` would
 * otherwise send a negative number, which browsers treat as a session cookie and
 * proxies ignore.
 */
export function secondsRemaining(
  expiresAt: Date | string | null | undefined,
  now = new Date(),
): number | null {
  const time = toTime(expiresAt);
  if (time === null) return null;
  return Math.max(0, Math.floor((time - now.getTime()) / 1000));
}
