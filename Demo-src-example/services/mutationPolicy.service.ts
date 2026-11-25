import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, notFound, refusal } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf, can, canAtScope, type Authority } from './authorisation.service';
import * as mutationPolicyRepo from '../repos/mutationPolicy.repo';
import * as authzRepo from '../repos/authz.repo';
import * as scopeRepo from '../repos/scope.repo';
import * as membershipRepo from '../repos/membership.repo';
import { canAct } from '../models/membership.model';
import { weakerTerms, type PolicyTerms, type StoredPolicy } from '../engine/mutation/policy.mutation';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * Mutations §9 and §14 — who must approve changes through a connection, and who
 * decides that.
 *
 * ── Policy authority ───────────────────────────────────────────────────────
 *
 * "mutation.policy sits with the connection's policy authority: owner set,
 * delegated, or locked by a super admin." The permission is necessary and not
 * sufficient. An admin holding `mutation.policy` in Engineering does not set the
 * rule for Finance's ledger; the ledger's owner does, or the person they handed
 * it to, or — once a super admin has locked it — a super admin alone.
 *
 * ── Floors ─────────────────────────────────────────────────────────────────
 *
 * "...with floors that a delegated admin may make stricter and never weaker."
 * A policy beneath its connection's floor is refused when somebody sets it, and
 * overridden when a chain is resolved against it — the second for the floor
 * raised after the policy was set.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

const audit = (actor: Actor) => ({
  organisationId: actor.organisationId,
  membershipId: actor.membershipId,
  userId: null,
});

/**
 * Whether this person may set policy on this connection.
 *
 * A SUPER ADMIN ALWAYS MAY, which is what makes "locked" mean anything. Short of
 * that the authority is the connection's: its owning membership, or an admin of
 * its owning scope, while it is owner-set; the named delegate while delegated;
 * nobody while locked.
 */
function governs(authority: Authority, governance: mutationPolicyRepo.Governance): boolean {
  if (!can(authority, 'mutation.policy')) return false;
  if (authority.isSuperAdmin) return true;

  switch (governance.authority) {
    case 'locked':
      return false;
    case 'delegated':
      return governance.grantedTo === authority.membershipId;
    case 'owner_set':
      return (
        governance.owningMembershipId === authority.membershipId ||
        (governance.owningScopePath !== null &&
          canAtScope(authority, 'mutation.policy', governance.owningScopePath))
      );
  }
}

/** The owner of a connection, for handing its authority on — not for setting policy. */
function owns(authority: Authority, governance: mutationPolicyRepo.Governance): boolean {
  return (
    governance.owningMembershipId === authority.membershipId ||
    (governance.owningScopePath !== null && canAtScope(authority, 'mutation.policy', governance.owningScopePath))
  );
}

async function governanceOf(db: PoolClient, connectionId: string): Promise<mutationPolicyRepo.Governance> {
  const [governance] = await mutationPolicyRepo.governanceOf(db, [connectionId]);
  if (!governance) {
    throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
  }
  return governance;
}

async function assertRole(db: PoolClient, roleId: string | null): Promise<void> {
  if (roleId === null) return;
  const roles = await authzRepo.listRoles(db);
  if (!roles.some((role) => role.id === roleId)) {
    throw invalid({ message: 'That role does not exist.', code: 'invalid.role' });
  }
}

const TERM_NAMES: Record<keyof PolicyTerms, string> = {
  approvalsRequired: 'the number of approvers',
  requiredRoleId: 'the role an approver must hold',
  allowSelfApproval: 'whether the proposer may approve',
  separateExecution: 'whether somebody else runs it',
  expiresAfterHours: 'how long approval stays open',
};

/* ── Reading ──────────────────────────────────────────────────────────────── */

export type PolicyOverview = {
  policies: StoredPolicy[];
  floors: mutationPolicyRepo.Floor[];
};

/**
 * Every policy and floor in force.
 *
 * FOR ANYBODY WHO CAN PROPOSE, APPROVE OR SET THEM. Somebody about to propose a
 * change should be able to see what it will need before they ask for it.
 */
export async function overview(actor: Actor): Promise<PolicyOverview> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      if (!['mutation.propose', 'mutation.approve', 'mutation.policy'].some((one) => can(authority, one))) {
        assertCan(authority, 'mutation.policy');
      }

      return { policies: await mutationPolicyRepo.livePolicies(db), floors: await mutationPolicyRepo.floors(db) };
    }),
  );
}

/* ── Policies ─────────────────────────────────────────────────────────────── */

/**
 * Put a policy in force: the organisation default, one connection's, or one
 * connection's for proposers in one scope.
 *
 * THE ORGANISATION DEFAULT IS A SUPER ADMIN'S. It applies to every connection
 * nobody configured, which is a rule about the whole organisation.
 */
export async function setPolicy(
  actor: Actor,
  input: { connectionId: string | null; scopeId: string | null; terms: PolicyTerms },
): Promise<PolicyOverview> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.policy');

      if (input.connectionId === null) {
        if (!authority.isSuperAdmin) {
          throw denial({
            message: 'Only a super admin sets the policy every connection falls back to.',
            code: 'denial.policy_authority',
          });
        }
      } else {
        const governance = await governanceOf(db, input.connectionId);
        if (!governs(authority, governance)) {
          throw denial({
            message: `Approval policy for ${governance.name} is not yours to set.`,
            code: 'denial.policy_authority',
          });
        }

        const floor = (await mutationPolicyRepo.floors(db)).find((one) => one.connectionId === input.connectionId);
        const weaker = floor ? weakerTerms(input.terms, floor) : [];
        if (weaker.length > 0) {
          throw refusal({
            message:
              `That is weaker than the minimum set for ${governance.name} on ` +
              `${weaker.map((term) => TERM_NAMES[term]).join(' and ')}. It can be made stricter, never weaker.`,
            code: 'refusal.policy_below_floor',
            detail: { connectionId: input.connectionId, terms: weaker },
          });
        }
      }

      if (input.scopeId !== null && !(await scopeRepo.findById(db, input.scopeId))) {
        throw notFound({ message: 'That scope does not exist.', code: 'missing.scope' });
      }
      await assertRole(db, input.terms.requiredRoleId);

      const { superseded } = await mutationPolicyRepo.setPolicy(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        connectionId: input.connectionId,
        scopeId: input.scopeId,
        terms: input.terms,
        setBy: actor.membershipId,
      });

      await writeAudit(db, {
        ...audit(actor),
        event: 'policy_changed',
        detail: {
          change: superseded ? 'replaced' : 'set',
          connectionId: input.connectionId,
          scopeId: input.scopeId,
          approvalsRequired: input.terms.approvalsRequired,
          requiredRoleId: input.terms.requiredRoleId,
          allowSelfApproval: input.terms.allowSelfApproval,
          separateExecution: input.terms.separateExecution,
          expiresAfterHours: input.terms.expiresAfterHours,
        },
      });
    }),
  );

  return overview(actor);
}

export async function removePolicy(
  actor: Actor,
  input: { connectionId: string | null; scopeId: string | null },
): Promise<void> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.policy');

      if (input.connectionId === null) {
        if (!authority.isSuperAdmin) {
          throw denial({
            message: 'Only a super admin sets the policy every connection falls back to.',
            code: 'denial.policy_authority',
          });
        }
      } else {
        const governance = await governanceOf(db, input.connectionId);
        if (!governs(authority, governance)) {
          throw denial({
            message: `Approval policy for ${governance.name} is not yours to set.`,
            code: 'denial.policy_authority',
          });
        }
      }

      const removed = await mutationPolicyRepo.removePolicy(db, input);
      if (!removed) {
        throw notFound({ message: 'There is no policy set there.', code: 'missing.mutation_policy' });
      }

      await writeAudit(db, {
        ...audit(actor),
        event: 'policy_changed',
        detail: { change: 'removed', connectionId: input.connectionId, scopeId: input.scopeId },
      });
    }),
  );
}

/* ── Floors ───────────────────────────────────────────────────────────────── */

/**
 * The minimum for one connection. A super admin's, because a floor the person
 * it constrains could lower would not be one.
 */
export async function setFloor(
  actor: Actor,
  input: { connectionId: string; terms: PolicyTerms },
): Promise<PolicyOverview> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.policy');
      if (!authority.isSuperAdmin) {
        throw denial({ message: 'Only a super admin sets a minimum policy.', code: 'denial.policy_floor' });
      }

      await governanceOf(db, input.connectionId);
      await assertRole(db, input.terms.requiredRoleId);

      await mutationPolicyRepo.setFloor(db, {
        organisationId: actor.organisationId,
        connectionId: input.connectionId,
        terms: input.terms,
        setBy: actor.membershipId,
      });

      await writeAudit(db, {
        ...audit(actor),
        event: 'policy_floor_set',
        detail: {
          change: 'set',
          connectionId: input.connectionId,
          approvalsRequired: input.terms.approvalsRequired,
          requiredRoleId: input.terms.requiredRoleId,
          allowSelfApproval: input.terms.allowSelfApproval,
          separateExecution: input.terms.separateExecution,
          expiresAfterHours: input.terms.expiresAfterHours,
        },
      });
    }),
  );

  return overview(actor);
}

export async function removeFloor(actor: Actor, connectionId: string): Promise<void> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.policy');
      if (!authority.isSuperAdmin) {
        throw denial({ message: 'Only a super admin sets a minimum policy.', code: 'denial.policy_floor' });
      }

      if (!(await mutationPolicyRepo.removeFloor(db, connectionId))) {
        throw notFound({ message: 'There is no minimum set for that connection.', code: 'missing.policy_floor' });
      }

      await writeAudit(db, {
        ...audit(actor),
        event: 'policy_floor_set',
        detail: { change: 'removed', connectionId },
      });
    }),
  );
}

/* ── Authority ────────────────────────────────────────────────────────────── */

/**
 * Hand a connection's policy authority on, take it back, lock it or unlock it.
 *
 * THE OWNER DELEGATES AND REVOKES; ONLY A SUPER ADMIN LOCKS OR UNLOCKS. A lock
 * the owner could lift would be a suggestion, and a locked connection's owner
 * can do nothing here at all until a super admin lifts it.
 */
export async function setAuthority(
  actor: Actor,
  input: { connectionId: string; authority: mutationPolicyRepo.PolicyAuthority; grantedTo: string | null },
): Promise<mutationPolicyRepo.Governance> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.policy');

      const governance = await governanceOf(db, input.connectionId);
      const locking = input.authority === 'locked' || governance.authority === 'locked';

      if (!authority.isSuperAdmin && (locking || !owns(authority, governance))) {
        throw denial({
          message: `Who sets approval policy for ${governance.name} is not yours to change.`,
          code: 'denial.policy_authority',
        });
      }

      if ((input.authority === 'delegated') !== (input.grantedTo !== null)) {
        throw invalid({
          message: 'Name the person when delegating, and only then.',
          code: 'invalid.policy_delegate',
        });
      }

      /* Read under the tenant, so a membership of another organisation is not found. */
      if (input.grantedTo !== null) {
        const delegate = await membershipRepo.findById(db, input.grantedTo);
        if (!delegate || !canAct(delegate)) {
          throw notFound({ message: 'That member does not exist.', code: 'missing.membership' });
        }
      }

      await mutationPolicyRepo.setAuthority(db, {
        connectionId: input.connectionId,
        authority: input.authority,
        grantedTo: input.grantedTo,
        setBy: actor.membershipId,
      });

      const connectionId = input.connectionId;

      if (input.authority === 'delegated') {
        await writeAudit(db, {
          ...audit(actor),
          event: 'policy_authority_delegated',
          detail: { connectionId, targetMembershipId: input.grantedTo },
        });
      } else if (governance.authority === 'delegated') {
        await writeAudit(db, {
          ...audit(actor),
          event: 'policy_authority_revoked',
          detail: { connectionId, targetMembershipId: governance.grantedTo },
        });
      }

      if (input.authority === 'locked' && governance.authority !== 'locked') {
        await writeAudit(db, { ...audit(actor), event: 'policy_authority_locked', detail: { connectionId } });
      }
      if (input.authority !== 'locked' && governance.authority === 'locked') {
        await writeAudit(db, { ...audit(actor), event: 'policy_authority_unlocked', detail: { connectionId } });
      }

      return governanceOf(db, input.connectionId);
    }),
  );
}
