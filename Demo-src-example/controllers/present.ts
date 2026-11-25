import type { Membership } from '../models/membership.model';
import type { MemberWithUser } from '../repos/membership.repo';
import type { Organisation } from '../models/organisation.model';
import type { User } from '../models/user.model';
import type { Session } from '../models/session.model';
import type { Invitation } from '../models/invitation.model';
import type { Scope, ScopeNode, ScopeType } from '../models/scope.model';
import type { Marking, Permission, Role, RoleAssignment } from '../models/authz.model';
import type { StoredEvent } from '../repos/authEvent.repo';
import type { Authority } from '../services/authorisation.service';
import { idsIn, leafIdOf } from '../utils/path.util';
import { PUBLISHED_DETAIL } from '../utils/audit.util';

/**
 * What a model looks like on the wire.
 *
 * ALLOW-LIST, NEVER A DENY-LIST, AND NEVER THE MODEL ITSELF. `User` carries
 * `passwordHash` and `Session` carries `tokenHash`; `res.json(user)` ships both.
 * A deny-list would work until somebody adds a field — and the failure mode of a
 * forgotten deny-list is silently publishing a secret, while the failure mode of
 * a forgotten allow-list entry is a missing field somebody notices immediately.
 *
 * DATES BECOME ISO STRINGS EXPLICITLY. `JSON.stringify` does it anyway, but doing
 * it here means the return types say `string` and a client's generated types
 * agree with what actually arrives.
 */

const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null;

export function presentUser(user: User) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    emailVerifiedAt: iso(user.emailVerifiedAt),
    avatarObjectKey: user.avatarObjectKey,
    status: user.status,
    createdAt: iso(user.createdAt),
    lastSeenAt: iso(user.lastSeenAt),
  };
}

export function presentMembership(membership: Membership) {
  return {
    id: membership.id,
    userId: membership.userId,
    organisationId: membership.organisationId,
    status: membership.status,
    jobTitle: membership.jobTitle,
    invitedAt: iso(membership.invitedAt),
    joinedAt: iso(membership.joinedAt),
    createdAt: iso(membership.createdAt),
  };
}

/**
 * A member as an administrator's list needs them.
 *
 * THE NAME AND ADDRESS ARE THE POINT. `presentMembership` alone gives a table of
 * uuids and statuses, which is not a list of people — an admin cannot suspend
 * the right person from it. This is the only presenter that reaches across into
 * `users`, and it is fed by a query that starts from the tenant-scoped
 * `memberships` table so it can only ever describe members of this
 * organisation.
 */
export function presentMember(member: MemberWithUser) {
  return {
    ...presentMembership(member),
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    lastSeenAt: iso(member.lastSeenAt),
  };
}

export function presentOrganisation(organisation: Organisation) {
  return {
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    plan: organisation.plan,
    ssoRequired: organisation.ssoRequired,
    mfaRequired: organisation.mfaRequired,
    storageEnabled: organisation.storageEnabled,
    logoObjectKey: organisation.logoObjectKey,
    billingStatus: organisation.billingStatus,
    createdAt: iso(organisation.createdAt),
  };
}

/**
 * A session, without the thing that is the session.
 *
 * `tokenHash` IS ABSENT AND SO IS THE TOKEN. The token is returned exactly once,
 * by the endpoint that mints it, and never again — including here. An endpoint
 * that could re-read a session's token would make every "list my sessions" call
 * a way to steal one.
 */
export function presentSession(session: Session) {
  return {
    id: session.id,
    activeMembershipId: session.activeMembershipId,
    issuedAt: iso(session.issuedAt),
    expiresAt: iso(session.expiresAt),
    lastSeenAt: iso(session.lastSeenAt),
    authMethod: session.authMethod,
    mfaSatisfied: session.mfaSatisfiedAt !== null,
  };
}

/**
 * An invitation as an administrator sees it.
 *
 * NO TOKEN AND NO HASH. The token goes to the invited address and nowhere else;
 * an admin listing that included it would let anyone who can invite also accept
 * on somebody else's behalf, which turns `member.invite` into `member.add`.
 */
export function presentInvitation(invitation: Invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    roleId: invitation.roleId,
    scopeId: invitation.scopeId,
    seatId: invitation.seatId,
    invitedBy: invitation.invitedBy,
    expiresAt: iso(invitation.expiresAt),
    acceptedAt: iso(invitation.acceptedAt),
    revokedAt: iso(invitation.revokedAt),
    createdAt: iso(invitation.createdAt),
  };
}

export function presentScopeType(type: ScopeType) {
  return {
    id: type.id,
    name: type.name,
    icon: type.icon,
    colour: type.colour,
    createdAt: iso(type.createdAt),
  };
}

export function presentScope(scope: Scope) {
  return {
    id: scope.id,
    name: scope.name,
    scopeTypeId: scope.scopeTypeId,
    parentId: scope.parentId,
    /*
     * THE PATH IS PUBLISHED, and it is a list of ids the caller already holds —
     * so it discloses nothing new, and it lets a client answer "is this beneath
     * that" without another round trip. The `s`-prefixed ltree labels are
     * unpicked into plain uuids here so a client never has to know the encoding.
     */
    path: idsIn(scope.path),
    depth: scope.depth,
    archivedAt: iso(scope.archivedAt),
    createdAt: iso(scope.createdAt),
  };
}

export function presentScopeTree(nodes: ScopeNode[]): unknown[] {
  return nodes.map((node) => ({
    ...presentScope(node),
    children: presentScopeTree(node.children),
  }));
}

export function presentRole(role: Role) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    systemRole: role.systemRole,
    createdAt: iso(role.createdAt),
  };
}

export function presentPermission(permission: Permission) {
  return {
    id: permission.id,
    category: permission.category,
    description: permission.description,
    scopeable: permission.scopeable,
  };
}

export function presentAssignment(assignment: RoleAssignment) {
  return {
    id: assignment.id,
    membershipId: assignment.membershipId,
    roleId: assignment.roleId,
    scopeType: assignment.scopeType,
    scopeId: assignment.scopeId,
    grantedBy: assignment.grantedBy,
    grantedAtScopeId: assignment.grantedAtScopeId,
    grantedAt: iso(assignment.grantedAt),
    expiresAt: iso(assignment.expiresAt),
  };
}

export function presentMarking(marking: Marking) {
  return {
    id: marking.id,
    name: marking.name,
    kind: marking.kind,
    description: marking.description,
  };
}

/**
 * What the caller may do, as the interface needs it.
 *
 * THE CLIENT USES THIS TO HIDE BUTTONS AND FOR NOTHING ELSE. Every one of these
 * permissions is checked again on the server when the button is pressed; sending
 * the list is a courtesy so the interface does not offer an action that will be
 * refused. A client that trusted it for anything more would be trusting a value
 * it received over the network to decide what it may do.
 */
export function presentAuthority(authority: Authority) {
  return {
    tier: authority.tier,
    isSuperAdmin: authority.isSuperAdmin,
    permissions: [...authority.permissions].sort(),
    clearances: [...authority.clearances].sort(),
    scopeIds: authority.scopePaths.map(leafIdOf),
    adminScopeIds: authority.adminPaths.map(leafIdOf),
  };
}

/**
 * One audit row, as a reviewer reads it.
 *
 * NAMED RATHER THAN SPREAD, like every other presenter here, so a column added
 * to `auth_events` tomorrow does not reach a client because somebody forgot
 * this file existed. That is the whole reason presenters are written out by
 * hand in this codebase.
 *
 * `ipHash` CROSSES AND IS NOT AN ADDRESS. It is a keyed hash, so a reviewer can
 * say "the same source tried eleven times" without the trail — or this response
 * — holding anybody's location. Comparing two rows is exactly what it is for;
 * reversing it needs a secret that is not in the database.
 *
 * `detail` IS FILTERED THROUGH AN ALLOW-LIST, not passed through. It is a jsonb
 * column written from a hundred and eighty places, and handing it over whole
 * breaks the rule at the top of this file in the one place that rule was
 * written for — the next person to add a key would publish it without ever
 * opening this file. The list lives beside the events in `audit.util`, where
 * somebody adding one is already working.
 *
 * WHAT IS WITHHELD IS NAMED, BY KEY AND NEVER BY VALUE. A reviewer handed a
 * silently trimmed row, in a product whose public page claims a complete trail,
 * is being misled in exactly the place completeness is the claim. `omitted`
 * says "there was a `lastFour` here and you are not being shown it", which is a
 * different statement from the row not having had one.
 */
export function presentAuthEvent(event: StoredEvent) {
  const detail: Record<string, unknown> = {};
  const omitted: string[] = [];

  for (const [key, value] of Object.entries(event.detail ?? {})) {
    if (PUBLISHED_DETAIL.has(key)) detail[key] = value;
    else omitted.push(key);
  }

  return {
    id: event.id,
    event: event.event,
    membershipId: event.membershipId,
    userId: event.userId,
    detail,
    /* Sorted so two rows of the same event read the same way. */
    omitted: omitted.sort(),
    ipHash: event.ipHash,
    occurredAt: event.occurredAt.toISOString(),
  };
}
