import { env } from '../config/env.config';
import { CLIENT_ROUTES } from '../config/constants.config';
import { actAsUser, withTransaction, withoutTenant } from '../infra/db.infra';
import { runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, notFound } from '../utils/error.util';
import { hashPassword, hashToken } from '../utils/hash.util';
import { generateId, generatePrefixedToken } from '../utils/tokens.util';
import { defaultExpiry, isRedeemable, matchesInvitee, stateOf } from '../models/invitation.model';
import type { Invitation } from '../models/invitation.model';
import type { Membership } from '../models/membership.model';
import * as invitationRepo from '../repos/invitation.repo';
import * as userRepo from '../repos/user.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as sessionService from './session.service';
import { log } from './audit.service';
import * as mailer from '../infra/mailer.infra';
import * as seatService from './seat.service';
import * as directory from '../infra/directory.infra';

/**
 * Inviting somebody, and accepting.
 *
 * ACCEPTANCE IS THE ONLY UNAUTHENTICATED WRITE THAT CREATES A MEMBERSHIP, which
 * makes it the most carefully guarded path in the system. The token is the
 * credential; the email is a second gate; and the whole thing happens in one
 * transaction so an invitation can never be half-accepted.
 */

export async function invite(input: {
  organisationId: string;
  invitedByMembershipId: string;
  email: string;
  roleId?: string | null;
  scopeId?: string | null;
  seatId?: string | null;
}): Promise<{ invitation: Invitation }> {
  return runWithTenant(
    { organisationId: input.organisationId, membershipId: input.invitedByMembershipId },
    async () =>
      withTransaction(async (db) => {
        const organisation = await organisationRepo.findById(db, input.organisationId);
        if (!organisation) throw notFound({ message: 'No such organisation.', code: 'missing.org' });

        const token = generatePrefixedToken('inv');

        /*
         * THE UNIQUE INDEX DOES THE WORK. `invitations_one_pending` is partial —
         * one outstanding invitation per address per organisation — so a second
         * invite while one is live fails at the database rather than by a check
         * that races. Re-inviting after revocation or acceptance is permitted,
         * which is what the partial predicate buys.
         */
        const invitation = await invitationRepo.create(db, {
          id: generateId(),
          organisationId: input.organisationId,
          email: input.email,
          tokenHash: hashToken(token),
          roleId: input.roleId,
          scopeId: input.scopeId,
          seatId: input.seatId,
          invitedBy: input.invitedByMembershipId,
          expiresAt: defaultExpiry(),
        });

        /*
         * THE SEAT IS RESERVED, NOT COUNTED, AND THE RESERVATION IS THE CHECK.
         * Reading "one left" and then sending the invitation is a read followed
         * by a write; two administrators inviting at the same moment both read
         * one-left and both send, and the second person to accept cannot be
         * seated. `reserveForInvitation` refuses with a capacity message when
         * nothing is free, which aborts this transaction — so no invitation is
         * created and no email goes out promising a seat that does not exist.
         */
        const seat = await seatService.reserveForInvitation(db, {
          invitationId: invitation.id,
          by: input.invitedByMembershipId,
        });

        await log(db, {
          event: 'member_invited',
          organisationId: input.organisationId,
          membershipId: input.invitedByMembershipId,
          userId: null,
          detail: {
            email: input.email,
            roleId: input.roleId ?? null,
            scopeId: input.scopeId ?? null,
            seatId: seat?.id ?? null,
          },
        });

        const link = `${env.APP_URL}${CLIENT_ROUTES.acceptInvitation}?token=${encodeURIComponent(token)}`;

        await mailer.send({
          to: input.email,
          subject: `You have been invited to ${organisation.name} on Silo`,
          text:
            `You have been invited to join ${organisation.name} on Silo.\n\n${link}\n\n` +
            `The invitation expires in 14 days. If you were not expecting it, ignore this ` +
            `message — nothing has been created in your name.\n\n—\nSilo\nsilohq.io`,
        });

        return { invitation };
      }),
  );
}

/**
 * Look at an invitation without accepting it.
 *
 * SO THE ACCEPTANCE PAGE CAN SAY WHICH ORGANISATION AND WHO INVITED THEM. It
 * returns the organisation's name and nothing else about it — a token holder is
 * not yet a member, and should not learn the member count, the plan or anything
 * else by holding a link.
 */
export async function preview(token: string): Promise<{
  organisationName: string;
  email: string;
  state: ReturnType<typeof stateOf>;
} | null> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      /*
       * THROUGH THE SECURITY DEFINER FUNCTION, because there is no tenant context
       * here and `invitations` is under a policy keyed on one. See
       * `002_auth.sql`: the function takes a hash and returns at most one row, so
       * holding the token is the only way to get anything out of it.
       */
      const found = await invitationRepo.findByToken(db, hashToken(token));
      if (!found) return null;

      return {
        organisationName: found.organisationName,
        email: found.invitation.email,
        state: stateOf(found.invitation),
      };
    }),
  );
}

/**
 * Accept.
 *
 * THE EMAIL IS CHECKED AGAINST THE INVITATION EVEN THOUGH THE TOKEN IS SECRET. An
 * invitation link forwarded to a colleague should not let that colleague join
 * under the intended person's role and seat. Compared case-insensitively, because
 * mail is.
 *
 * A USER MAY ALREADY EXIST. Somebody invited to a second organisation signs in
 * with the password they already have — so this creates a user only when there
 * is none, and never overwrites an existing password with one supplied here.
 */
export async function accept(input: {
  token: string;
  email: string;
  /** Only used when creating a new user. Ignored for an existing account. */
  password?: string;
  firstName?: string;
  lastName?: string;
  context?: { ip?: string | null; userAgent?: string | null };
}): Promise<{ membership: Membership; sessionToken: string }> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      // See `preview`: no tenant context exists on this path.
      const found = await invitationRepo.findByToken(db, hashToken(input.token));
      const invitation = found?.invitation ?? null;

      if (!invitation || !isRedeemable(invitation)) {
        throw invalid({
          message: 'That invitation is no longer valid. Ask for a new one.',
          code: 'invalid.invitation',
        });
      }

      if (!matchesInvitee(invitation, input.email)) {
        throw denial({
          message: 'This invitation was sent to a different email address.',
          code: 'denial.invitation_wrong_email',
        });
      }

      /*
       * THE TENANT CONTEXT COMES FROM THE VALIDATED INVITATION, and this is the
       * point at which it can. Both checks are done — the token resolved and the
       * address matched — so the right to join this organisation is established;
       * everything after this is a write into it, and `memberships` has
       * `WITH CHECK (organisation_id = app_org_id())`.
       *
       * Without it the acceptance fails with
       * `new row violates row-level security policy for table "memberships"`,
       * which is the same shape of bug registration had: a legitimate write into
       * a tenant, made by somebody who is not yet in it.
       *
       * SET AFTER THE CHECKS, NEVER BEFORE. Setting it from an unvalidated token
       * would mean a forged or expired invitation still established a tenant
       * context, and every subsequent statement in this transaction would run
       * inside a tenant the caller had no claim to.
       */
      await invitationRepo.actAsOrganisation(db, invitation.organisationId);

      let user = await userRepo.findByEmail(db, invitation.email);
      /*
       * AN EXISTING USER ACCEPTING A SECOND INVITATION. `user_by_email` found
       * them without a policy; everything after this — the membership, the
       * session — is an ordinary write on their rows.
       */
      if (user) await actAsUser(db, user.id);

      if (!user) {
        if (!input.password || !input.firstName || !input.lastName) {
          throw invalid({
            message: 'Set a name and password to create your account.',
            code: 'invalid.registration_incomplete',
          });
        }
        /*
         * Same shape as registration: the id is generated first so `users_own`
         * can be satisfied by the very insert that creates the row. An invitee
         * has no session and no identity until this succeeds.
         */
        const userId = generateId();
        await actAsUser(db, userId);

        user = await userRepo.create(db, {
          id: userId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: invitation.email,
          passwordHash: await hashPassword(input.password),
        });
        /*
         * THE ADDRESS IS VERIFIED BY THE INVITATION ITSELF. The token was
         * delivered to it, so receiving it proves control of the mailbox — the
         * same thing a verification email would prove, already done.
         */
        await userRepo.markEmailVerified(db, user.id);

        /*
         * A NEW ACCOUNT GOES IN THE DIRECTORY, wherever it was created from. An
         * invitee whose account is made here and never recorded would be routed
         * to whichever cell they happened to open next time, and told their
         * password is wrong.
         */
        await directory.record(invitation.email);
      }

      /*
       * MARKED ACCEPTED BEFORE THE MEMBERSHIP IS CREATED, and the update's own
       * `WHERE` is what makes it single-use. Two simultaneous acceptances race
       * here rather than both proceeding to create memberships — the loser gets
       * null and fails, having created nothing.
       */
      const claimed = await invitationRepo.claimByToken(db, hashToken(input.token));
      if (!claimed) {
        throw invalid({
          message: 'That invitation has already been used.',
          code: 'invalid.invitation_used',
        });
      }

      const existing = await membershipRepo.findByUserAndOrganisation(
        db,
        user.id,
        invitation.organisationId,
      );

      const membership =
        existing ??
        (await membershipRepo.create(db, {
          id: generateId(),
          userId: user.id,
          organisationId: invitation.organisationId,
          status: 'active',
          invitedBy: invitation.invitedBy,
        }));

      // A previously removed or suspended member being re-invited comes back.
      if (existing && existing.status !== 'active') {
        await membershipRepo.setStatus(db, existing.id, 'active');
      }

      /*
       * THE RESERVATION BECOMES OCCUPANCY, in the same transaction that creates
       * the membership. The seat was already taken out of the pool when the
       * invitation was sent, so this cannot fail for capacity — which is the
       * point of reserving rather than counting. Doing it here rather than at
       * invite time is what keeps a seat attached to a person rather than to a
       * promise.
       */
      await seatService.claimForMembership(db, {
        invitationId: invitation.id,
        membershipId: membership.id,
      });

      const { token: sessionToken } = await sessionService.issue({
        db,
        userId: user.id,
        activeMembershipId: membership.id,
        authMethod: 'password',
        ip: input.context?.ip,
        userAgent: input.context?.userAgent,
      });

      await log(db, {
        event: 'member_joined',
        organisationId: invitation.organisationId,
        membershipId: membership.id,
        userId: user.id,
        detail: { via: 'invitation', invitationId: invitation.id },
      });

      return { membership, sessionToken };
    }),
  );
}

export async function revoke(input: {
  organisationId: string;
  actingMembershipId: string;
  invitationId: string;
}): Promise<void> {
  await runWithTenant(
    { organisationId: input.organisationId, membershipId: input.actingMembershipId },
    async () =>
      withTransaction(async (db) => {
        await invitationRepo.revoke(db, input.invitationId);

        /*
         * THE SEAT GOES BACK TO THE POOL. A revoked invitation that kept its
         * reservation would leak a licence per withdrawn invite — invisible,
         * cumulative, and only noticed when an organisation with obvious spare
         * capacity is told it has none.
         */
        await seatService.releaseReservation(db, input.invitationId);

        await log(db, {
          event: 'member_invited',
          organisationId: input.organisationId,
          membershipId: input.actingMembershipId,
          userId: null,
          detail: { invitationId: input.invitationId, action: 'revoked' },
        });
      }),
  );
}
