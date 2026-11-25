import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { notFound } from '../utils/error.util';
import type { Membership, MembershipStatus } from '../models/membership.model';
import * as membershipRepo from '../repos/membership.repo';
import * as automationService from './automation.service';
import * as viewTransferService from './viewTransfer.service';
import * as sessionRepo from '../repos/session.repo';
import * as scopeRepo from '../repos/scope.repo';
import { authorityOf, type Authority } from './authorisation.service';
import { denial } from '../utils/error.util';
import { contains } from '../utils/path.util';
import { log } from './audit.service';
import type { PoolClient } from 'pg';

/**
 * Suspending, reinstating and removing a member.
 *
 * NONE OF THESE REVOKE A GRANT. Suspension and removal SILENCE grants — the rows
 * stay, with `granted_by` intact — so reinstatement restores exactly what the
 * person had rather than requiring every admin who ever granted them anything to
 * grant it again. Cascading revocation on a personnel change produces an outage
 * traced to an offboarding, and nobody can reconstruct what was lost.
 *
 * NONE OF THESE TOUCH THE SEAT EITHER. A person leaving and a company reducing
 * its licence count are different decisions, taken by different people, needing
 * different permissions. Freeing the seat is a second, deliberate action.
 *
 * ── AND ALL OF THEM ARE BOUNDED BY THE ACTOR'S SUBTREE ────────────────────
 *
 * §6 — an admin's reach is "That scope and every descendant. NOTHING OUTSIDE
 * IT." `member.suspend` and `member.remove` sit on the Admin role, which is the
 * scope-admin tier, and the routes gate on the bare permission because a router
 * cannot see which scopes the target belongs to.
 *
 * Nothing checked it here either, so a scope admin could suspend or remove any
 * member of the organisation — a peer in a sibling subtree, or a super admin.
 * The only guard was a self-target check in the controller.
 */

/**
 * Revision 5 — "Any admin whose subtree contains a scope the membership belongs
 * to may suspend."
 *
 * A MEMBERSHIP IN NO SCOPE IS REACHABLE ONLY BY A SUPER ADMIN. That is the safe
 * reading rather than an oversight: somebody who belongs to no part of the
 * organisation sits under no scope admin, so there is no admin whose subtree
 * contains them.
 */
async function assertWithinSubtree(
  db: PoolClient,
  authority: Authority,
  targetMembershipId: string,
): Promise<void> {
  if (authority.isSuperAdmin) return;

  const targetPaths = await scopeRepo.pathsForMembership(db, targetMembershipId);
  const reachable = targetPaths.some((path) =>
    authority.adminPaths.some((admin) => contains(admin, path)),
  );

  if (!reachable) {
    throw denial({
      message: 'That is outside the part of the organisation you administer.',
      code: 'denial.outside_subtree',
      detail: { adminPaths: authority.adminPaths },
    });
  }
}

async function setStatus(input: {
  organisationId: string;
  actingMembershipId: string;
  targetMembershipId: string;
  status: MembershipStatus;
  event: 'member_suspended' | 'member_removed' | 'member_reinstated';
}): Promise<Membership> {
  return runWithTenant(
    { organisationId: input.organisationId, membershipId: input.actingMembershipId },
    async () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, input.actingMembershipId, input.organisationId);
        await assertWithinSubtree(db, authority, input.targetMembershipId);

        const updated = await membershipRepo.setStatus(db, input.targetMembershipId, input.status);

        if (!updated) {
          // Under RLS a membership in another tenant is simply not visible, so
          // "not found" and "not yours" are the same observation. Answering
          // differently would make the status code an existence oracle.
          throw notFound({ message: 'No such member.', code: 'missing.membership' });
        }

        /*
         * SESSIONS GO IMMEDIATELY. A suspended member with a live session keeps
         * working until it expires, which can be eight hours — and suspension is
         * exactly the action taken when somebody must stop now.
         */
        const revoked =
          input.status === 'active' ? [] : await sessionRepo.revokeAllForMembership(db, input.targetMembershipId);

        await log(db, {
          event: input.event,
          organisationId: input.organisationId,
          membershipId: input.actingMembershipId,
          userId: null,
          detail: {
            targetMembershipId: input.targetMembershipId,
            sessionsRevoked: revoked.length,
            seatReleased: false,
            grantsSilenced: input.status !== 'active',
          },
        });

        /*
         * RECORDED SEPARATELY WHEN GRANTS WERE STILL LIVE. A reviewer asking
         * "what did this person still have access to when they were suspended"
         * needs an event that says so, not an inference from two other rows.
         */
        /*
         * Automations §9 — "On owner removal, automations pause and surface to
         * the admin above them for review. They do not continue running under a
         * removed identity." Suspension pauses them for the same reason: §6
         * intersects an automation's permissions with what its owner holds AT
         * RUN TIME, so a suspended owner's checks would otherwise fail every
         * run until somebody noticed.
         *
         * THEY DO NOT COME BACK ON REINSTATEMENT. Resuming a scheduled change
         * is its own decision, which is why `active` does not undo this.
         */
        if (input.status === 'suspended' || input.status === 'removed') {
          await automationService.pauseOnOwnerChange(db, {
            organisationId: input.organisationId,
            membershipId: input.targetMembershipId,
            reason: 'owner_removed',
          });
        }

        /*
         * AUTH rev 7 — "On removal, every view owned by that membership
         * transfers to the admin above them… Transferred views arrive FLAGGED,
         * not shared."
         *
         * IN THIS TRANSACTION, so there is no moment at which a membership is
         * removed and its saved views still belong to it. A second transaction
         * would leave that gap, and the gap is exactly the state rev 7 is
         * written to prevent: shared access standing in an owner's name after
         * the owner has gone.
         *
         * SUSPENSION TRANSFERS TOO, for the reason it pauses crons. A suspended
         * person cannot answer for a view either, and their shares are as
         * unaccountable as a removed person's — with the difference that the
         * transfer is reviewable, so reinstating them leaves an admin holding a
         * view they can hand back by sharing it on.
         */
        if (input.status === 'suspended' || input.status === 'removed') {
          await viewTransferService.onMembershipChange(db, {
            organisationId: input.organisationId,
            membershipId: input.targetMembershipId,
            reason: input.status === 'removed' ? 'member_removed' : 'member_suspended',
          });
        }

        if (input.status === 'suspended' || input.status === 'removed') {
          await log(db, {
            event: 'grants_silenced',
            organisationId: input.organisationId,
            membershipId: input.actingMembershipId,
            userId: null,
            detail: { targetMembershipId: input.targetMembershipId, reason: input.status },
          });
        }

        if (input.status === 'active') {
          await log(db, {
            event: 'grants_restored',
            organisationId: input.organisationId,
            membershipId: input.actingMembershipId,
            userId: null,
            detail: { targetMembershipId: input.targetMembershipId },
          });
        }

        return updated;
      }),
  );
}

export function suspend(input: {
  organisationId: string;
  actingMembershipId: string;
  targetMembershipId: string;
}): Promise<Membership> {
  return setStatus({ ...input, status: 'suspended', event: 'member_suspended' });
}

export function remove(input: {
  organisationId: string;
  actingMembershipId: string;
  targetMembershipId: string;
}): Promise<Membership> {
  return setStatus({ ...input, status: 'removed', event: 'member_removed' });
}

export function reinstate(input: {
  organisationId: string;
  actingMembershipId: string;
  targetMembershipId: string;
}): Promise<Membership> {
  return setStatus({ ...input, status: 'active', event: 'member_reinstated' });
}

export async function list(input: {
  organisationId: string;
  actingMembershipId: string;
  status?: MembershipStatus;
}): Promise<membershipRepo.MemberWithUser[]> {
  return runWithTenant(
    { organisationId: input.organisationId, membershipId: input.actingMembershipId },
    async () =>
      withTransaction((db) =>
        membershipRepo.listForOrganisationWithUser(db, { status: input.status }),
      ),
  );
}
