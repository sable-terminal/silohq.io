import { isActive } from '../utils/expiry.util';
import { SESSION_TTL_SECONDS } from '../config/constants.config';

/**
 * A logged-in session.
 *
 * OPAQUE AND SERVER-SIDE. Not a JWT: revocation must take effect on the next
 * request, and a signed token can only be revoked by keeping a denylist, which is
 * this table with extra steps.
 *
 * A SESSION IS BOUND TO ONE MEMBERSHIP AT A TIME. Switching organisation issues a
 * NEW session rather than mutating this one, so a session's authority never
 * changes underneath a request that is already running, and an audit row naming a
 * session names one tenant.
 */

export type AuthMethod = 'password' | 'sso' | 'agent';

export interface Session {
  id: string;
  userId: string;
  activeMembershipId: string | null;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  ipHash: string | null;
  userAgentHash: string | null;
  authMethod: AuthMethod;
  mfaSatisfiedAt: Date | null;
}

export function isUsable(session: Session, now = new Date()): boolean {
  return isActive({ expiresAt: session.expiresAt, revokedAt: session.revokedAt }, now);
}

/**
 * Whether this session may do anything beyond choosing an organisation.
 *
 * TWO STATES ARE AUTHENTICATED AND AUTHORISED FOR NOTHING, and both are
 * legitimate rather than errors:
 *
 *   1. No active membership — the password verified and no organisation has been
 *      chosen. The only permitted action is choosing one.
 *   2. MFA required and not satisfied — the person is who they say they are and
 *      has not finished proving it.
 *
 * Collapsing either into "not logged in" would send somebody back to the login
 * form having already given a correct password, which they will read as the
 * password being wrong.
 */
export function isAuthorised(
  session: Session,
  organisationRequiresMfa: boolean,
  now = new Date(),
): boolean {
  if (!isUsable(session, now)) return false;
  if (session.activeMembershipId === null) return false;
  if (organisationRequiresMfa && session.mfaSatisfiedAt === null) return false;
  return true;
}

/** Why a usable session is not yet authorised, for the caller to act on. */
export type PendingReason = 'choose-organisation' | 'satisfy-mfa' | null;

export function pendingReason(
  session: Session,
  organisationRequiresMfa: boolean,
): PendingReason {
  if (session.activeMembershipId === null) return 'choose-organisation';
  if (organisationRequiresMfa && session.mfaSatisfiedAt === null) return 'satisfy-mfa';
  return null;
}

export function defaultExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_SECONDS * 1000);
}
