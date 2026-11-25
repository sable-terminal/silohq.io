import { isActive } from '../utils/expiry.util';
import { INVITATION_TTL_DAYS } from '../config/constants.config';

/**
 * An offer of membership.
 *
 * WHAT IT GRANTS IS HELD, NOT APPLIED. The role, scope and seat are recorded on
 * the invitation and take effect on acceptance — so an invitation that expires or
 * is revoked has granted nothing, and a seat held for an invitation that is never
 * accepted can be reclaimed without unpicking a membership that half-exists.
 */

export interface Invitation {
  id: string;
  organisationId: string;
  email: string;
  tokenHash: string;
  roleId: string | null;
  scopeId: string | null;
  seatId: string | null;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export function stateOf(invitation: Invitation, now = new Date()): InvitationState {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.revokedAt) return 'revoked';
  if (!isActive({ expiresAt: invitation.expiresAt, revokedAt: null }, now)) return 'expired';
  return 'pending';
}

export function isRedeemable(invitation: Invitation, now = new Date()): boolean {
  return stateOf(invitation, now) === 'pending';
}

export function defaultExpiry(from = new Date()): Date {
  return new Date(from.getTime() + INVITATION_TTL_DAYS * 86_400_000);
}

/**
 * Whether the person accepting is the person invited.
 *
 * COMPARED CASE-INSENSITIVELY, BECAUSE MAIL IS. `Tommy@silohq.io` and
 * `tommy@silohq.io` are one mailbox, and refusing the acceptance because the
 * capitalisation differs is a support ticket, not a security control.
 *
 * IT IS STILL CHECKED. The token is the credential and this is a second gate: a
 * forwarded invitation link should not let a different person join the tenant
 * under the invitee's intended role.
 */
export function matchesInvitee(invitation: Invitation, email: string): boolean {
  return invitation.email.toLowerCase() === email.trim().toLowerCase();
}
