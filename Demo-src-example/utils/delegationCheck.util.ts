import { contains } from './path.util';

/**
 * The six delegation rules, checked before a grant is written.
 *
 * ENFORCED HERE *AND* BY CONSTRAINT. This is the readable version, the one that
 * can explain which rule failed and why. The database rejects the same grants
 * with no explanation. Neither is redundant: this one gives a usable error, that
 * one is what holds when somebody writes a repository that forgets to call this.
 *
 * ALL SIX ARE CHECKED, NOT SHORT-CIRCUITED. A grant failing three rules should
 * report three, or the granter fixes one, retries, and discovers the next — which
 * turns a single rejection into a guessing game about the shape of the hierarchy.
 */

export interface Granter {
  membershipId: string;
  /** The scope the granter is acting under. Null means organisation-wide. */
  actingScopePath: string | null;
  isSuperAdmin: boolean;
  /** Permissions the granter effectively holds at the target scope. */
  effectivePermissions: ReadonlySet<string>;
  /** Roles this granter's roles are whitelisted to assign. */
  grantableRoles: ReadonlySet<string>;
  /** Connections the granter holds at the target scope. */
  heldConnections: ReadonlySet<string>;
}

export interface ProposedGrant {
  /** Null means an organisation-wide grant: a super admin. */
  targetScopePath: string | null;
  roleId?: string;
  permissions: readonly string[];
  connectionIds?: readonly string[];
}

export type DelegationRule =
  | 'subtree-containment'
  | 'no-escalation'
  | 'no-null-scope'
  | 'no-clearance-delegation'
  | 'whitelisted-role'
  | 'connection-subset';

export interface DelegationFailure {
  rule: DelegationRule;
  message: string;
}

/**
 * Never delegable, to anyone, including an admin holding every other permission.
 *
 * NAMED, NOT DERIVED FROM A RULE. An earlier version of this comment offered a
 * test — "checked with assertCan, therefore organisation-wide" — and put all four
 * Silo permissions here by it. The test was wrong: `concept.confirm` meets it and
 * is deliberately delegable, and §4 of the Capture specification gives
 * `silo.create` and `silo.manage` to Admin. Each entry is here because a
 * specification says, of that permission, that it is not delegable.
 *
 * `clearance.grant`: an admin able to grant it could clear themselves. It is the
 * mandatory gate, and a gate whose keys can be copied is not one.
 *
 * `discovery.manage`: §9.1 — a scope admin administers part of a network, and
 * authorising a scan would authorise scanning the parts they do not administer.
 *
 * `silo.enable`: Capture §3–§4 — "super admin only, never delegable". It changes
 * the deployment's security posture and belongs with clearance.
 *
 * `marking.apply`: deciding what is secret is an organisation-wide statement —
 * `SYSTEM_ROLES` gives it to Super admin alone for that reason — and it is the
 * one permission that can strip the marking every clearance check reads. A scope
 * admin holding it could unmark a concept and then nominate it for storage the
 * marking check at add time had refused.
 *
 * ── Not delegable, and not conferred by a scoped assignment ────────────────
 *
 * Rule 2 does not cover these on its own: once a super admin puts one in a
 * role, its holder passes the no-escalation check and could pass it on. And a
 * role holding one, ASSIGNED AT A SCOPE, used to confer it — `authorityOf` gives
 * a scoped assignment every permission in the role, and `assertCan` asks only
 * whether a permission is held. So a Super admin role assigned to a department
 * handed `silo.enable` to somebody who was not a super admin. `isSuperAdminOnly`
 * is what `authorityOf` asks, so a scoped assignment never carries these.
 */
const NEVER_DELEGABLE = new Set([
  'clearance.grant',
  'discovery.manage',
  'silo.enable',
  'marking.apply',
]);

/** Held only through an organisation-wide assignment, and never passed on. */
export function isSuperAdminOnly(permission: string): boolean {
  return NEVER_DELEGABLE.has(permission);
}

export function checkDelegation(
  granter: Granter,
  grant: ProposedGrant,
): { permitted: boolean; failures: DelegationFailure[] } {
  const failures: DelegationFailure[] = [];

  /*
   * 1. SUBTREE CONTAINMENT. An admin in one tree cannot create an admin in
   *    another. Impossible, not merely hidden from the interface.
   */
  if (!granter.isSuperAdmin) {
    if (granter.actingScopePath === null) {
      failures.push({
        rule: 'subtree-containment',
        message: 'A non-super-admin cannot grant without acting under a scope.',
      });
    } else if (grant.targetScopePath === null) {
      failures.push({
        rule: 'no-null-scope',
        message: 'Only a super admin may issue an organisation-wide grant.',
      });
    } else if (!contains(granter.actingScopePath, grant.targetScopePath)) {
      failures.push({
        rule: 'subtree-containment',
        message: 'The target scope is not within the granting admin’s subtree.',
      });
    }
  }

  /*
   * 2. NO ESCALATION. The granted set must be a subset of what the granter holds
   *    AT THE TARGET SCOPE — not what they hold anywhere. An admin with wide
   *    permissions in one branch cannot use them to grant in another.
   */
  const escalations = grant.permissions.filter((p) => !granter.effectivePermissions.has(p));
  if (escalations.length > 0 && !granter.isSuperAdmin) {
    failures.push({
      rule: 'no-escalation',
      message: `Cannot grant permissions the granter does not hold: ${escalations.join(', ')}.`,
    });
  }

  /*
   * 3. NOT DELEGABLE. Super admin only, and never delegable even to an admin
   *    holding every other permission — see `NEVER_DELEGABLE` for what makes a
   *    permission one of these. Rule 2 does not cover it: once a super admin
   *    puts one in a custom role, its holder passes the no-escalation check and
   *    can pass it on, which is authority granted outside these rules.
   */
  const clearance = grant.permissions.filter((p) => NEVER_DELEGABLE.has(p));
  if (clearance.length > 0 && !granter.isSuperAdmin) {
    failures.push({
      rule: 'no-clearance-delegation',
      message: `${clearance.join(', ')} is never delegable. Super admin only.`,
    });
  }

  /*
   * 4. WHITELISTED ROLES. Holding a permission is not the same as being allowed
   *    to hand out a role that contains it.
   */
  if (grant.roleId && !granter.isSuperAdmin && !granter.grantableRoles.has(grant.roleId)) {
    failures.push({
      rule: 'whitelisted-role',
      message: 'This role is not in the granting role’s whitelist.',
    });
  }

  /*
   * 5. CONNECTION SUBSET. An admin may pass on only connections they themselves
   *    hold at that scope.
   */
  const unheld = (grant.connectionIds ?? []).filter((c) => !granter.heldConnections.has(c));
  if (unheld.length > 0 && !granter.isSuperAdmin) {
    failures.push({
      rule: 'connection-subset',
      message: `Cannot grant connections the granter does not hold: ${unheld.join(', ')}.`,
    });
  }

  return { permitted: failures.length === 0, failures };
}
