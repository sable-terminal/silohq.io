// Invitations (spec 55.6, 56.7).
//
// Issuing: the policy service decides member.invite at the scope; the delegation rules
// are then asked whether the inviter may give this role there, so an invitation that
// could never be accepted is refused now rather than when the person arrives. One open
// invitation per address; the token goes to the delivery and only its hash is stored.
//
// Accepting: a new person chooses a password (checked as any new password is); an
// existing person proves the account with their current one. Membership, role
// assignment (granted by the inviter, under the delegation trigger, which checks the
// inviter still has the authority) and scope membership are written in one transaction
// with the invitation marked accepted. Then the person is signed in.

import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { SessionView } from '../../contracts/auth/session.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Invitation } from '../../models/iam/invitation.model.ts';
import {
  invitationRepo, membershipRepo, organisationRepo, roleAssignmentRepo, scopeMembershipRepo, userRepo,
} from '../../repos/iam/index.repo.ts';
import { normaliseEmail } from '../../utils/email.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashToken, issueToken } from '../../utils/token.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import { grantAfterAssignment, seatOnJoin } from './seats.service.ts';
import type { AuthDeps } from './deps.service.ts';
import { login } from './login.service.ts';
import { checkNewPassword } from './passwordReset.service.ts';

export interface InvitationInput {
  email: string;
  roleId: string;
  scopeId?: string | undefined;
}

export async function createInvitation(deps: AuthDeps, ctx: HandlerContext, input: InvitationInput)
  : Promise<{ invitationId: string; expiresAt: string }> {
  const organisationId = ctx.request.organisationId!;
  const inviter = ctx.request.membershipId;
  if (inviter === undefined) throw new AppError('forbidden', 'an invitation is sent by a member', { code: 'auth.not_permitted' });

  const decision = await deps.services.call(authorise, {
    body: { permission: 'member.invite', ...(input.scopeId ? { scopeId: input.scopeId } : {}) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', 'you may not invite people there', { code: 'auth.not_permitted', details: { reason: decision.reason } });
  }

  const control = deps.databases.pool('control');
  const email = normaliseEmail(input.email);
  const existing = await inTransaction(control, {}, (db) => userRepo.findForLogin(db, email));
  const { token, hash } = issueToken('invitation');
  const expiresAt = new Date(Date.now() + deps.config.security.invitationDays * 86_400_000).toISOString();
  const invitationId = uuidv7();
  // The stored expiry, so a replayed request returns exactly what the first did.
  const stored = await inTransaction(control, { organisationId, membershipId: inviter }, async (db) => {
    const refusal = await roleAssignmentRepo.grantRefusal(db, organisationId, inviter, input.roleId, input.scopeId ?? null);
    if (refusal !== null) {
      throw new AppError('forbidden', `that role cannot be given there: ${refusal}`, { code: 'auth.grant_refused' });
    }
    if (existing) {
      const membership = await membershipRepo.findByUserId(db, { userId: existing.id, organisationId });
      if (membership && membership.status !== 'invited') {
        throw new AppError('conflict', 'that person is already a member', { code: 'invitation.already_member' });
      }
    }
    let row;
    try {
      row = await invitationRepo.insert(db, {
        id: invitationId, organisationId, email, tokenHash: hash, roleId: input.roleId, scopeId: input.scopeId ?? null,
        invitedBy: inviter, expiresAt,
      });
    } catch (error) {
      const mapped = fromDatabaseError(error);
      if (mapped.category === 'conflict') {
        throw new AppError('conflict', 'that address already has an open invitation', { code: 'invitation.already_open' });
      }
      throw mapped;
    }
    await recordAuthEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'member_invited', membershipId: inviter,
      detail: { invitation_id: invitationId, role_id: input.roleId, ...(input.scopeId ? { scope_id: input.scopeId } : {}) },
    });
    return row.expiresAt;
  });
  await deps.invitationDelivery.deliver({ organisationId, invitationId, email, token, expiresAt: stored, correlationId: ctx.correlationId });
  return { invitationId, expiresAt: stored };
}

export async function readInvitation(deps: AuthDeps, ctx: HandlerContext, invitationId: string)
  : Promise<{ invitationId: string; expiresAt: string }> {
  const invitation = await inTransaction(deps.databases.pool('control'), { organisationId: ctx.request.organisationId! }, (db) =>
    invitationRepo.findById(db, invitationId));
  if (!invitation) throw new AppError('not_found', 'no such invitation', { code: 'invitation.not_found' });
  return { invitationId: invitation.id, expiresAt: invitation.expiresAt };
}

export interface AcceptInput {
  organisationSlug: string;
  token: string;
  password: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  client?: { address?: string | undefined; userAgent?: string | undefined } | undefined;
}

export async function acceptInvitation(deps: AuthDeps, input: AcceptInput, correlationId: string)
  : Promise<SessionView & { sessionToken: string }> {
  const control = deps.databases.pool('control');
  const invalid = new AppError('unauthenticated', 'this invitation is not valid; ask for a new one', { code: 'auth.invitation_invalid' });
  const organisation = await inTransaction(control, {}, (db) => organisationRepo.findForLogin(db, input.organisationSlug));
  if (!organisation || organisation.status !== 'active') throw invalid;
  if (organisation.ssoRequired) {
    throw new AppError('forbidden', 'this organisation signs in through its identity provider', { code: 'auth.sso_required' });
  }
  const invitation = await inTransaction(control, { organisationId: organisation.id }, (db) =>
    invitationRepo.findByTokenHash(db, { organisationId: organisation.id, tokenHash: hashToken(input.token) }));
  if (!invitation || invitation.acceptedAt !== null || invitation.revokedAt !== null || Date.parse(invitation.expiresAt) <= Date.now()) {
    throw invalid;
  }

  const existing = await inTransaction(control, {}, (db) => userRepo.findForLogin(db, invitation.email));
  let userId: string;
  let newUser: { passwordHash: string } | undefined;
  if (existing) {
    // The account exists: its owner proves it with their current password.
    if (existing.status !== 'active' || existing.passwordHash === null || !await deps.hasher.verify(input.password, existing.passwordHash)) {
      throw new AppError('unauthenticated', 'the password is not right for this account', { code: 'auth.login_failed' });
    }
    userId = existing.id;
  } else {
    if (input.firstName === undefined || input.lastName === undefined) {
      throw new AppError('validation', 'a new account needs a first and last name', { code: 'invitation.name_required' });
    }
    await checkNewPassword(deps, input.password);
    userId = uuidv7();
    newUser = { passwordHash: await deps.hasher.hash(input.password) };
  }

  let membershipId: string;
  try {
    membershipId = await inTransaction(control, { organisationId: organisation.id, userId }, async (db) => {
      if (newUser) {
        await userRepo.insert(db, {
          id: userId, firstName: input.firstName!, lastName: input.lastName!, email: invitation.email, passwordHash: newUser.passwordHash,
          emailVerifiedAt: new Date().toISOString(),
        });
      }
      return joinByInvitation(db, invitation, userId, { correlationId, newAccount: newUser !== undefined, via: 'password' });
    });
  } catch (error) {
    throw asInviterRefusal(error);
  }
  await grantAfterAssignment(deps, organisation.id, membershipId, correlationId);
  if (newUser) await deps.directory.registerIdentity({ userId, email: invitation.email }, correlationId);
  return login(deps, { organisationSlug: input.organisationSlug, email: invitation.email, password: input.password, client: input.client },
    correlationId);
}

/**
 * The delegation trigger refuses (insufficient_privilege) when the inviter no longer holds
 * the authority; inTransaction has already made it an AppError.
 */
export function asInviterRefusal(error: unknown): unknown {
  if (isAppError(error) && error.details['sqlstate'] === '42501') {
    return new AppError('forbidden', 'the person who invited you can no longer give this role; ask for a new invitation', {
      code: 'invitation.inviter_lacks_authority',
    });
  }
  return error;
}

/**
 * Joins the invited person to the organisation, inside the caller's transaction (context:
 * the organisation and the user): the membership, the role granted by the inviter (under
 * the delegation trigger), the scope, and the invitation marked accepted. Returns the
 * membership.
 */
export async function joinByInvitation(db: Queryable, invitation: Invitation, userId: string,
  how: { correlationId: string; newAccount: boolean; via: 'password' | 'sso' }): Promise<string> {
  const organisationId = invitation.organisationId;
  const prior = await membershipRepo.findByUserId(db, { userId, organisationId });
  if (prior && prior.status !== 'invited') {
    throw new AppError('conflict', 'you are already a member of this organisation', { code: 'invitation.already_member' });
  }
  const joinedAt = new Date().toISOString();
  const membershipId = prior?.id ?? uuidv7();
  if (prior) {
    await membershipRepo.update(db, prior.id, { status: 'active', joinedAt });
  } else {
    await membershipRepo.insert(db, {
      id: membershipId, userId, organisationId, status: 'active', invitedBy: invitation.invitedBy,
      invitedAt: invitation.createdAt, joinedAt,
    });
  }
  const actedAt = invitation.scopeId === null
    ? null : await roleAssignmentRepo.actingScope(db, organisationId, invitation.invitedBy, invitation.scopeId);
  await roleAssignmentRepo.insert(db, {
    id: uuidv7(), organisationId, membershipId, roleId: invitation.roleId, onScopeId: invitation.scopeId,
    grantedBy: invitation.invitedBy, grantedAtScopeId: actedAt,
  });
  if (invitation.scopeId !== null) {
    await scopeMembershipRepo.insert(db, {
      id: uuidv7(), organisationId, membershipId, scopeId: invitation.scopeId, isPrimary: true, addedBy: invitation.invitedBy,
    });
  }
  await invitationRepo.update(db, invitation.id, { acceptedAt: joinedAt, acceptedMembershipId: membershipId });
  // A seat from the invitation's scope pool, or the organisation's, when one is free (spec 72.3).
  await seatOnJoin(db, { organisationId, membershipId }, how.correlationId, membershipId, invitation.scopeId);
  await recordAuthEvent(db, {
    organisationId, correlationId: how.correlationId, event: 'member_joined', userId, membershipId,
    detail: { invitation_id: invitation.id, new_account: how.newAccount, method: how.via },
  });
  return membershipId;
}

/** An invitation that may still be accepted, or undefined. */
export const openInvitation = (invitation: Invitation | undefined): Invitation | undefined =>
  invitation && invitation.acceptedAt === null && invitation.revokedAt === null && Date.parse(invitation.expiresAt) > Date.now()
    ? invitation : undefined;
