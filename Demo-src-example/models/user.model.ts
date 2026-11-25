import { hasExpired } from '../utils/expiry.util';
import { LOCKOUT_SECONDS, MAX_FAILED_ATTEMPTS } from '../config/constants.config';

/**
 * A person, globally.
 *
 * A USER IS NOT A TENANT MEMBER. One person with one password may belong to
 * organisations in different tenants; what they may DO lives on `memberships`.
 * Everything here is about identity — can this person prove who they are — and
 * nothing about authority.
 */

export type UserStatus = 'active' | 'suspended' | 'deprovisioned';

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  failedAttemptCount: number;
  lockedUntil: Date | null;
  avatarObjectKey: string | null;
  avatarContentType: string | null;
  status: UserStatus;
  createdAt: Date;
  lastSeenAt: Date | null;
}

export function fullName(user: Pick<User, 'firstName' | 'lastName'>): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

export function isLocked(user: Pick<User, 'lockedUntil'>, now = new Date()): boolean {
  return user.lockedUntil !== null && !hasExpired(user.lockedUntil, now);
}

/**
 * Whether this account may attempt to authenticate at all.
 *
 * SUSPENSION AND LOCKOUT ARE DIFFERENT THINGS AND BOTH DENY. A lockout is
 * automatic, temporary and caused by the person themselves; a suspension is
 * administrative and lasts until somebody lifts it. They are separate fields
 * because conflating them means a lockout expiring silently un-suspends an
 * account, and there is no way to tell the two states apart in an audit.
 */
export function canAttemptLogin(user: User, now = new Date()): boolean {
  return user.status === 'active' && !isLocked(user, now);
}

/**
 * What a failed attempt does to the account.
 *
 * THE COUNTER IS CLEARED ON SUCCESS, NOT ON EXPIRY OF THE LOCKOUT. Leaving it at
 * the threshold means the next single failure re-locks immediately, so somebody
 * who mistyped once and then waited out a lockout is locked again by one more
 * typo — which reads as the lockout not working.
 */
export function afterFailedAttempt(
  user: Pick<User, 'failedAttemptCount'>,
  now = new Date(),
): { failedAttemptCount: number; lockedUntil: Date | null } {
  const count = user.failedAttemptCount + 1;
  return {
    failedAttemptCount: count,
    lockedUntil: count >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_SECONDS * 1000) : null,
  };
}

/**
 * Whether this account can be authenticated by password at all.
 *
 * AN SSO-ONLY USER HAS NO HASH, AND THAT IS A LEGITIMATE ROW. The danger is a
 * verifier treating "nothing to compare against" as anything other than a
 * refusal, so the state is named here rather than inferred from a null at each
 * call site.
 */
export function hasPassword(user: Pick<User, 'passwordHash'>): boolean {
  return user.passwordHash !== null;
}
