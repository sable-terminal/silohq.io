/**
 * A person's place in one organisation.
 *
 * THE BINDING RULE. Every authorisation decision, every audit row and every owned
 * resource references a membership, never a user. A user in three organisations
 * has three memberships and no permission crosses between them. Writing a
 * permission against a user id would make the tenant boundary a convention.
 */

export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface Membership {
  id: string;
  userId: string;
  organisationId: string;
  status: MembershipStatus;
  jobTitle: string | null;
  invitedBy: string | null;
  invitedAt: Date | null;
  joinedAt: Date | null;
  createdAt: Date;
}

/**
 * Whether this membership may act.
 *
 * ONLY `active`. An invited membership has not accepted, a suspended one is
 * deliberately stopped, and a removed one has left — and the last two must not be
 * conflated. Suspension silences grants without revoking them, so reinstatement
 * restores the prior state; removal is a departure.
 */
export function canAct(membership: Pick<Membership, 'status'>): boolean {
  return membership.status === 'active';
}

/**
 * Whether grants are silenced rather than revoked.
 *
 * SUSPENSION SILENCES, REMOVAL SILENCES, NEITHER REVOKES. The issuing admins'
 * records stay intact either way, so reinstating somebody restores what they had
 * rather than requiring every admin who ever granted them anything to grant it
 * again. Cascading revocation on a personnel change produces an outage traced to
 * an offboarding.
 */
export function grantsSilenced(membership: Pick<Membership, 'status'>): boolean {
  return membership.status === 'suspended' || membership.status === 'removed';
}

/**
 * Whether removing this membership frees its seat.
 *
 * IT DOES NOT, AND THAT IS DELIBERATE. A person leaving and a company reducing
 * its licence count are different decisions taken by different people at
 * different times. Releasing the seat automatically means a routine offboarding
 * silently reduces capacity, and re-adding it later is a billing event nobody
 * authorised. Freeing the seat is a second action, needing `seat.release`.
 */
export const REMOVAL_RELEASES_SEAT = false;
