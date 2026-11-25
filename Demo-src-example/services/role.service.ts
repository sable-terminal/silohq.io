import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, notFound, policy } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import {
  GRANTABLE, SYSTEM_ROLES, type Clearance, type Marking, type Permission, type Role, type RoleAssignment,
} from '../models/authz.model';
import * as authzRepo from '../repos/authz.repo';
import * as scopeRepo from '../repos/scope.repo';
import * as membershipRepo from '../repos/membership.repo';
import { authorityOf, assertCan, checkGrant, type Authority } from './authorisation.service';
import { contains } from '../utils/path.util';
import { log } from './audit.service';
import { assertGrantableToPrincipal } from './principal.service';
import type { Actor } from './scope.service';

/**
 * Granting and revoking roles and clearances.
 *
 * EVERY GRANT GOES THROUGH THE SIX DELEGATION RULES, and they are checked here
 * before the write rather than trusted to the caller. `delegationCheck.util` is
 * the readable version that can say which rule failed; the database constraints
 * are what hold when somebody writes a second path that forgets to call this.
 */

async function withAuthority<T>(
  actor: Actor,
  fn: (db: Parameters<Parameters<typeof withTransaction>[0]>[0], authority: Authority) => Promise<T>,
): Promise<T> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => fn(db, await authorityOf(db, actor.membershipId, actor.organisationId))),
  );
}

/**
 * Create the three system roles and their grant whitelist.
 *
 * CALLED ONCE, AT REGISTRATION, IN THE SAME TRANSACTION. An organisation without
 * them has no super admin, and therefore nobody who can create one — the
 * permission to do it belongs to the role that does not exist.
 */
export async function seedSystemRoles(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  organisationId: string,
  founderMembershipId: string,
): Promise<{ superAdminRoleId: string }> {
  const created = new Map<string, string>();

  for (const definition of Object.values(SYSTEM_ROLES)) {
    const role = await authzRepo.createRole(db, {
      id: generateId(),
      organisationId,
      name: definition.name,
      description: definition.description,
      systemRole: true,
      permissions: definition.permissions,
    });
    created.set(definition.name, role.id);
  }

  // The whitelist: who may hand out what. See `GRANTABLE`.
  for (const [granting, grantable] of Object.entries(GRANTABLE)) {
    const grantingId = created.get(granting);
    if (!grantingId) continue;
    await authzRepo.setGrantableRoles(
      db,
      grantingId,
      grantable.map((name) => created.get(name)).filter((id): id is string => Boolean(id)),
    );
  }

  const superAdminRoleId = created.get(SYSTEM_ROLES.superAdmin.name)!;

  /*
   * THE FOUNDER IS MADE SUPER ADMIN WITH NO SCOPE, granting themselves — the one
   * place in the system where `granted_by` equals the recipient. Every subsequent
   * admin is delegated by somebody under the subtree rules; this is the root of
   * that chain and the only point at which it can begin.
   */
  await authzRepo.assign(db, {
    id: generateId(),
    membershipId: founderMembershipId,
    roleId: superAdminRoleId,
    scopeType: null,
    scopeId: null,
    grantedBy: founderMembershipId,
    grantedAtScopeId: null,
  });

  return { superAdminRoleId };
}

export async function listRoles(actor: Actor): Promise<Role[]> {
  return withAuthority(actor, (db) => authzRepo.listRoles(db));
}

export async function listPermissions(actor: Actor): Promise<Permission[]> {
  return withAuthority(actor, (db) => authzRepo.listPermissions(db));
}

/**
 * Grant a role.
 *
 * THE SCOPE PATH IS RESOLVED BEFORE THE RULES RUN, because five of the six are
 * expressed in terms of it. Passing a scope id to the delegation check and
 * resolving it inside would put a database read in a pure function.
 */
export async function grant(
  actor: Actor,
  input: { targetMembershipId: string; roleId: string; scopeId: string | null; expiresAt?: Date | null },
): Promise<RoleAssignment> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'role.grant');

    const target = await membershipRepo.findById(db, input.targetMembershipId);
    if (!target) throw notFound({ message: 'No such member.', code: 'missing.membership' });

    let targetScopePath: string | null = null;
    let grantedAtScopeId: string | null = null;

    if (input.scopeId) {
      const scope = await scopeRepo.findById(db, input.scopeId);
      if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });
      targetScopePath = scope.path;
      grantedAtScopeId = scope.id;
    }

    const permissions = await authzRepo.permissionsOfRole(db, input.roleId);

    const decision = await checkGrant(db, authority, {
      targetScopePath,
      roleId: input.roleId,
      permissions,
    });

    if (!decision.permitted) {
      /*
       * EVERY BROKEN RULE IS REPORTED, NOT THE FIRST. Otherwise the granter fixes
       * one, retries, discovers the next, and a single rejection becomes a
       * guessing game about the shape of the hierarchy.
       */
      throw denial({
        message: decision.failures.map((f) => f.message).join(' '),
        code: 'denial.delegation',
        detail: { failures: decision.failures },
      });
    }

    const assignment = await authzRepo.assign(db, {
      id: generateId(),
      membershipId: input.targetMembershipId,
      roleId: input.roleId,
      scopeType: input.scopeId ? 'scope' : null,
      scopeId: input.scopeId,
      grantedBy: actor.membershipId,
      /*
       * THE SCOPE THE GRANTER WAS ACTING UNDER, recorded so the grant stays
       * auditable after a restructure. Without it, a later change to the tree
       * makes it impossible to establish whether this was valid when issued.
       */
      grantedAtScopeId,
      expiresAt: input.expiresAt,
    });

    await log(db, {
      event: input.scopeId ? 'admin_delegated' : 'role_granted',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: input.scopeId
        ? {
            granterMembershipId: actor.membershipId,
            granterScopePath: authority.adminPaths.join(',') || 'organisation',
            targetScopePath,
            permissions,
            targetMembershipId: input.targetMembershipId,
          }
        : {
            targetMembershipId: input.targetMembershipId,
            roleId: input.roleId,
            grantedAtScopePath: 'organisation',
          },
    });

    return assignment;
  });
}

/**
 * Revoke a grant.
 *
 * REVOCATION AUTHORITY IS NOT THE SAME AS ADMINISTERING THE PERSON. A grant is
 * revocable by whoever issued it, by an admin whose subtree contains the scope it
 * was issued under, or by a super admin — not by every admin the user happens to
 * sit under. An Engineering admin cannot revoke access issued by the Falcon
 * admin, even though both administer the same person. The `WHERE` clause in the
 * repo is what enforces it.
 */
/**
 * Grant a role to a machine identity.
 *
 * SEPARATE FROM `grant` BECAUSE THE RULES DIFFER, not because the code would
 * not fit. A principal cannot hold organisation-wide authority: a credential
 * sitting in a config file that reaches everything cannot be scoped, cannot
 * satisfy a second factor, and notifies nobody when it is used. Anything a
 * script genuinely needs everywhere is a sign the scope model is wrong rather
 * than a reason to allow this.
 *
 * The delegation rules are otherwise the same, and `checkGrant` still refuses a
 * PRINCIPAL doing the granting — a key that can widen its own permissions turns
 * one leaked secret into a permanent escalation.
 */
export async function grantToPrincipal(
  actor: Actor,
  input: { principalId: string; roleId: string; scopeId: string; expiresAt?: Date | null },
): Promise<RoleAssignment> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'role.grant');
    assertGrantableToPrincipal(input.scopeId);

    const scope = await scopeRepo.findById(db, input.scopeId);
    if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    if (!authority.isSuperAdmin && !authority.adminPaths.some((p) => contains(p, scope.path))) {
      throw denial({
        message: 'That is outside the part of the organisation you administer.',
        code: 'denial.outside_subtree',
      });
    }

    const assignment = await authzRepo.assign(db, {
      id: generateId(),
      principalId: input.principalId,
      roleId: input.roleId,
      scopeType: 'scope',
      scopeId: input.scopeId,
      grantedBy: actor.membershipId,
      grantedAtScopeId: input.scopeId,
      expiresAt: input.expiresAt ?? null,
    });

    await log(db, {
      event: 'principal_role_granted',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        principalId: input.principalId,
        roleId: input.roleId,
        grantedAtScopePath: scope.path,
      },
    });

    return assignment;
  });
}

export async function revoke(actor: Actor, assignmentId: string): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'role.grant');

    const revoked = await authzRepo.revokeAssignment(db, {
      assignmentId,
      revokedBy: actor.membershipId,
      revokerScopePaths: authority.adminPaths,
      isSuperAdmin: authority.isSuperAdmin,
    });

    if (!revoked) {
      throw denial({
        message: 'That grant was issued outside the part of the organisation you administer.',
        code: 'denial.revocation_authority',
      });
    }

    await log(db, {
      event: revoked.grantedBy === actor.membershipId ? 'role_revoked' : 'grant_revoked_by_other_admin',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        grantId: assignmentId,
        originalGranterMembershipId: revoked.grantedBy,
        revokerMembershipId: actor.membershipId,
      },
    });
  });
}

/**
 * Grants an admin issued that outlive them.
 *
 * SURFACED FOR REVIEW, NOT CASCADED. Revoking an admin does not revoke what they
 * granted: cascading would strip access from people who legitimately need it and
 * produce an outage traced to a personnel change.
 */
export async function orphanedGrants(actor: Actor, formerAdminId: string): Promise<RoleAssignment[]> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'role.grant');
    return authzRepo.orphanedGrants(db, formerAdminId);
  });
}

/* ── Clearances ──────────────────────────────────────────────────────────── */

export async function createMarking(
  actor: Actor,
  input: { name: string; kind: Marking['kind']; description?: string | null },
): Promise<Marking> {
  return withAuthority(actor, async (db, authority) => {
    if (!authority.isSuperAdmin) {
      throw policy({
        message: 'Only a super admin can define markings.',
        code: 'policy.marking_super_admin_only',
      });
    }

    const marking = await authzRepo.createMarking(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      name: input.name,
      kind: input.kind,
      description: input.description,
    });

    await log(db, {
      event: 'concept_marking_changed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { markingId: marking.id, name: marking.name, action: 'created' },
    });

    return marking;
  });
}

/**
 * Grant a clearance.
 *
 * SUPER ADMIN ONLY, AND NEVER DELEGABLE — delegation rule 4. An admin able to
 * grant clearance could clear themselves, which makes the mandatory gate
 * discretionary. It is refused here even for an admin holding every other
 * permission, and `delegationCheck` refuses it again on any grant that includes
 * `clearance.grant`.
 */
export async function grantClearance(
  actor: Actor,
  input: { targetMembershipId: string; markingId: string; expiresAt?: Date | null },
): Promise<Clearance> {
  return withAuthority(actor, async (db, authority) => {
    if (!authority.isSuperAdmin) {
      throw denial({
        message: 'Only a super admin can grant a clearance.',
        code: 'denial.clearance_grant',
      });
    }

    const clearance = await authzRepo.grantClearance(db, {
      id: generateId(),
      membershipId: input.targetMembershipId,
      markingId: input.markingId,
      grantedBy: actor.membershipId,
      expiresAt: input.expiresAt,
    });

    await log(db, {
      event: 'clearance_granted',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { targetMembershipId: input.targetMembershipId, markingId: input.markingId },
    });

    return clearance;
  });
}

export async function revokeClearance(
  actor: Actor,
  input: { targetMembershipId: string; markingId: string },
): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    if (!authority.isSuperAdmin) {
      throw denial({
        message: 'Only a super admin can revoke a clearance.',
        code: 'denial.clearance_revoke',
      });
    }

    await authzRepo.revokeClearance(db, input.targetMembershipId, input.markingId);

    await log(db, {
      event: 'clearance_revoked',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { targetMembershipId: input.targetMembershipId, markingId: input.markingId },
    });
  });
}

export async function listMarkings(actor: Actor): Promise<Marking[]> {
  return withAuthority(actor, (db) => authzRepo.listMarkings(db));
}
