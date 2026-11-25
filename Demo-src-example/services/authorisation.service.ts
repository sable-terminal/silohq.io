import type { PoolClient } from 'pg';
import { denial } from '../utils/error.util';
import { contains } from '../utils/path.util';
import { checkDelegation, isSuperAdminOnly, type Granter, type ProposedGrant } from '../utils/delegationCheck.util';
import { checkMarkings, requiredMarkings } from '../utils/markingCheck.util';
import { tierOf, type AdminTier } from '../models/authz.model';
import * as authzRepo from '../repos/authz.repo';
import * as scopeRepo from '../repos/scope.repo';

/**
 * What a membership may actually do, resolved from the database.
 *
 * THIS IS THE FILE THAT MAKES `effectivePermissions.util` REAL. The util has the
 * combining rules and no data; the repos have the data and no rules. Until this
 * existed, every active member could do everything the API exposed, because
 * nothing ever asked.
 *
 * RESOLVED ONCE PER REQUEST AND CACHED FOR EXACTLY THAT LONG. A grant revoked
 * mid-session must bite on the next request, so any cache with a lifetime beyond
 * one request is a window in which it does not. The cache here is a Map handed in
 * by the caller and thrown away with the request.
 */

export interface Authority {
  /** Who this authority belongs to: a person, or a machine identity. */
  subject: authzRepo.Subject;
  /**
   * Null for a service principal.
   *
   * KEPT SEPARATE FROM `subject` RATHER THAN COLLAPSED INTO IT, because the
   * things that need a membership genuinely need a membership — delegation,
   * scope containment, an audit row naming a person — and a nullable field makes
   * the compiler ask about the principal case at each one instead of letting a
   * principal id flow into a column that references `memberships`.
   */
  membershipId: string | null;
  organisationId: string;
  tier: AdminTier;
  /** Every permission, unioned across every scope the membership belongs to. */
  permissions: ReadonlySet<string>;
  /** Paths of scopes this membership BELONGS to. */
  scopePaths: readonly string[];
  /** Paths this membership ADMINISTERS. Empty for a member. */
  adminPaths: readonly string[];
  /** Marking ids held, expiry applied. */
  clearances: ReadonlySet<string>;
  isSuperAdmin: boolean;
}

/**
 * Load everything an authorisation decision needs, in three queries.
 *
 * THE TWO PATH SETS ARE DIFFERENT AND CONFLATING THEM IS A PRIVILEGE ESCALATION.
 * `scopePaths` is where you sit — it decides which grants reach you.
 * `adminPaths` is what you administer — it decides what you can do to others.
 * A member of Engineering has Engineering in the first and nothing in the second.
 */
export async function authorityOf(
  db: PoolClient,
  membershipId: string,
  organisationId: string,
): Promise<Authority> {
  return authorityOfSubject(db, { kind: 'membership', id: membershipId }, organisationId);
}

/**
 * The same computation for a machine identity.
 *
 * IT SHARES THE ENGINE RATHER THAN MIRRORING IT. A second implementation of
 * "what may this subject do" drifts from the first, and the one nobody reads is
 * the one that gains a bug — which here means a script quietly doing more than
 * the model says.
 *
 * A PRINCIPAL HAS NO SCOPE MEMBERSHIP AND NO CLEARANCES. It does not sit
 * anywhere, so nothing is implied by where it is; its reach is exactly what has
 * been granted to it. Clearances are withheld deliberately: a marking is a
 * mandatory control over data a person was trusted with, and handing that trust
 * to a credential in a config file is not a thing an administrator should be
 * able to do by accident.
 */
export async function authorityOfPrincipal(
  db: PoolClient,
  principalId: string,
  organisationId: string,
): Promise<Authority> {
  return authorityOfSubject(db, { kind: 'principal', id: principalId }, organisationId);
}

async function authorityOfSubject(
  db: PoolClient,
  subject: authzRepo.Subject,
  organisationId: string,
): Promise<Authority> {
  const membershipId = subject.kind === 'membership' ? subject.id : null;

  const [assignments, scopePaths, clearances] = await Promise.all([
    authzRepo.effectiveAssignments(db, subject),
    membershipId ? scopeRepo.pathsForMembership(db, membershipId) : Promise.resolve([]),
    membershipId ? authzRepo.heldMarkings(db, membershipId) : Promise.resolve(new Set<string>()),
  ]);

  const permissions = new Set<string>();
  const adminPaths: string[] = [];
  let isSuperAdmin = false;

  for (const assignment of assignments) {
    /*
     * AN ORGANISATION-WIDE ASSIGNMENT REACHES EVERYWHERE. That is what a super
     * admin is — there is no `is_super_admin` column, because the assignment
     * already says it and a second source of truth would eventually disagree.
     */
    if (assignment.scopeType === null) {
      isSuperAdmin = true;
      for (const permission of assignment.permissions) permissions.add(permission);
      continue;
    }

    if (assignment.scopeType === 'scope' && assignment.scopePath) {
      adminPaths.push(assignment.scopePath);

      /*
       * A SCOPED ASSIGNMENT GRANTS ITS PERMISSIONS TO THE HOLDER UNCONDITIONALLY,
       * whether or not they also SIT in that scope. Being made admin of
       * Engineering gives you Engineering's permissions; requiring membership as
       * well would mean appointing an admin took two steps and forgetting the
       * second produced an admin who could do nothing.
       */
      /*
       * NOT THE SUPER-ADMIN-ONLY ONES. `silo.enable`, `clearance.grant`,
       * `discovery.manage` and `marking.apply` act on the whole organisation,
       * so a scoped copy of them is not a narrower version — it is the whole
       * thing, one delegation below where it belongs.
       */
      for (const permission of assignment.permissions) {
        if (!isSuperAdminOnly(permission)) permissions.add(permission);
      }
      continue;
    }

    // Scoped directly to one resource. Resolved at the point of use.
    for (const permission of assignment.permissions) {
      if (!isSuperAdminOnly(permission)) permissions.add(permission);
    }
  }

  return {
    subject,
    membershipId,
    organisationId,
    tier: tierOf(assignments),
    permissions,
    scopePaths,
    adminPaths,
    clearances,
    isSuperAdmin,
  };
}

/** Whether a permission is held at all, ignoring scope. */
export function can(authority: Authority, permission: string): boolean {
  return authority.permissions.has(permission);
}

/**
 * Whether a permission is held over a particular scope.
 *
 * A SUPER ADMIN PASSES EVERY SCOPE CHECK AND STILL FAILS EVERY MARKING CHECK.
 * That separation is what makes clearance meaningful: the person who can do
 * anything administratively still cannot read a compartment they do not hold.
 */
export function canAtScope(authority: Authority, permission: string, scopePath: string): boolean {
  if (!authority.permissions.has(permission)) return false;
  if (authority.isSuperAdmin) return true;
  return authority.adminPaths.some((admin) => contains(admin, scopePath));
}

export function assertCan(authority: Authority, permission: string): void {
  if (!can(authority, permission)) {
    /*
     * THE MESSAGE NAMES THE PERMISSION, NOT THE RESOURCE. "You need
     * `member.suspend`" is actionable — the reader can ask for it by name.
     * Naming the resource confirms it exists to somebody who may not see it.
     */
    throw denial({
      message: `You need the ${permission} permission to do that.`,
      code: `denial.${permission}`,
      detail: { permission, membershipId: authority.membershipId },
    });
  }
}

export function assertCanAtScope(authority: Authority, permission: string, scopePath: string): void {
  assertCan(authority, permission);
  if (!canAtScope(authority, permission, scopePath)) {
    throw denial({
      message: 'That is outside the part of the organisation you administer.',
      code: 'denial.outside_subtree',
      detail: { permission, scopePath, adminPaths: authority.adminPaths },
    });
  }
}

/**
 * The mandatory gate.
 *
 * INTERSECTION, AND NO ROLE OVERRIDES IT. A missing marking denies however many
 * permissions the membership holds and whatever tier it is. There is deliberately
 * no super-admin bypass — that is the entire reason clearance is separate from
 * role.
 */
export async function assertCleared(
  db: PoolClient,
  authority: Authority,
  resource: { type: string; id: string; conceptIds?: readonly string[] },
): Promise<void> {
  const direct = await authzRepo.markingsOnResource(db, resource.type, resource.id);

  const conceptMarkings: string[][] = [];
  for (const conceptId of resource.conceptIds ?? []) {
    conceptMarkings.push(await authzRepo.markingsOnResource(db, 'concept', conceptId));
  }

  const requirement = requiredMarkings({ resource: direct, concepts: conceptMarkings });
  const decision = checkMarkings(requirement, { held: authority.clearances });

  if (!decision.permitted) {
    /*
     * THE MISSING MARKINGS GO IN THE DETAIL, NOT THE MESSAGE. Telling somebody
     * they lack `PROJECT ORION` confirms a compartment by that name exists and
     * that something in it is relevant to their question — which is exactly what
     * a compartment hides. The audit row gets the names; the person does not.
     */
    throw denial({
      message: 'You do not have clearance for part of this.',
      code: 'denial.clearance',
      detail: { missing: decision.missing, resource: `${resource.type}:${resource.id}` },
    });
  }
}

/**
 * Check a proposed grant against all six delegation rules.
 *
 * THE GRANTER'S EFFECTIVE PERMISSIONS ARE TAKEN AT THE TARGET SCOPE, not
 * wherever they are strongest. An admin with wide permissions in one branch must
 * not be able to use them to grant in another, and passing their global set would
 * do exactly that.
 */
export async function checkGrant(
  db: PoolClient,
  granter: Authority,
  grant: ProposedGrant,
): Promise<{ permitted: boolean; failures: Array<{ rule: string; message: string }> }> {
  /*
   * A MACHINE IDENTITY CANNOT DELEGATE, AND THIS IS WHERE THAT IS ENFORCED.
   * An API key that can widen its own permissions — or hand them to somebody
   * else — turns one leaked secret into an escalation path no human approved.
   * The compiler asks the question here because `membershipId` is nullable for
   * exactly this reason.
   */
  if (granter.subject.kind === 'principal' || granter.membershipId === null) {
    return {
      permitted: false,
      failures: [
        {
          rule: 'subject',
          message: 'A service principal cannot grant roles. Ask a person to do it.',
        },
      ],
    };
  }

  const grantableRoles = await authzRepo.grantableRolesFor(db, granter.membershipId);

  const asGranter: Granter = {
    membershipId: granter.membershipId,
    // The scope they are acting under: their admin path containing the target.
    actingScopePath: granter.isSuperAdmin
      ? null
      : (granter.adminPaths.find((p) => grant.targetScopePath && contains(p, grant.targetScopePath)) ??
         granter.adminPaths[0] ??
         null),
    isSuperAdmin: granter.isSuperAdmin,
    effectivePermissions: granter.permissions,
    grantableRoles,
    /*
     * §6 rule 6 IS ENFORCED, AND NOT HERE.
     *
     * This path decides whether one membership may give another a ROLE, and a
     * role carries no connections. Passing a connection on is
     * `connectionGrant.grant`, which asks the question directly: it refuses
     * anybody who does not hold the connection themselves, by the same
     * `readableIds` a query uses.
     *
     * The empty set used to be accompanied by a comment saying connections
     * "are not yet built", which stopped being true at migration 014 and left
     * a reader believing the rule was unimplemented everywhere. It is empty
     * because no proposed ROLE grant names a connection, which is the safe
     * answer and also the correct one.
     */
    heldConnections: new Set(),
  };

  return checkDelegation(asGranter, grant);
}

export { checkDelegation };
