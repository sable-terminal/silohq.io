import type { Request, Response } from 'express';
import * as memberService from '../services/member.service';
import * as invitationService from '../services/invitation.service';
import { withTransaction } from '../infra/db.infra';
import * as invitationRepo from '../repos/invitation.repo';
import { body, params, query } from '../middleware/validate.middleware';
import { clientIp, userAgent } from '../middleware/requestContext.middleware';
import { actorOf, authorityFor } from '../middleware/authorise.middleware';
import { authConfig } from '../config/auth.config';
import { SESSION_TTL_SECONDS } from '../config/constants.config';
import { notFound, policy } from '../utils/error.util';
import { presentAuthority, presentInvitation, presentMember, presentMembership } from './present';
import type * as schema from '../schemas/member.schema';

/**
 * People, and the two ways they arrive.
 *
 * THE SERVICES BEHIND THESE DO NOT CHECK PERMISSIONS. `member.service` and most
 * of `invitation.service` take an acting membership and trust it — so the
 * `requirePermission` in the router is the only gate, and removing it opens the
 * endpoint rather than merely worsening the error. That is the exception in this
 * codebase and it is written on both sides: here, and in the router.
 */

export async function list(req: Request, res: Response): Promise<void> {
  const { status } = query<schema.ListMembersQuery>(req);
  const actor = actorOf(req);

  const members = await memberService.list({
    organisationId: actor.organisationId,
    actingMembershipId: actor.membershipId,
    status,
  });

  res.status(200).json({ members: members.map(presentMember) });
}

/**
 * SUSPEND, REMOVE AND REINSTATE ARE THREE ENDPOINTS AND NOT ONE `PATCH status`.
 * They are three different decisions with different consequences — suspension
 * keeps the seat, removal frees it, reinstatement needs one to be free — and a
 * single status field invites a client to move between any two of them. The
 * audit trail also reads as what happened rather than as a sequence of writes to
 * a column.
 */
async function transition(
  req: Request,
  res: Response,
  action: 'suspend' | 'remove' | 'reinstate',
): Promise<void> {
  const { membershipId } = params<{ membershipId: string }>(req);
  const actor = actorOf(req);

  /*
   * A MEMBER MAY NOT ACT ON THEMSELF. Suspending yourself is merely odd;
   * removing yourself when you are the only super admin leaves an organisation
   * nobody can administer, and there is no supported way back from that.
   */
  if (membershipId === actor.membershipId) {
    throw policy({
      message: 'You cannot change your own membership. Ask another administrator.',
      code: 'policy.self_target',
    });
  }

  const membership = await memberService[action]({
    organisationId: actor.organisationId,
    actingMembershipId: actor.membershipId,
    targetMembershipId: membershipId,
  });

  res.status(200).json({ membership: presentMembership(membership) });
}

export const suspend = (req: Request, res: Response) => transition(req, res, 'suspend');
export const remove = (req: Request, res: Response) => transition(req, res, 'remove');
export const reinstate = (req: Request, res: Response) => transition(req, res, 'reinstate');

/** What the signed-in member may do. For drawing the interface, nothing more. */
export async function authority(req: Request, res: Response): Promise<void> {
  res.status(200).json({ authority: presentAuthority(await authorityFor(req)) });
}

/* ── Invitations ────────────────────────────────────────────────────────── */

export async function invite(req: Request, res: Response): Promise<void> {
  const input = body<schema.InviteBody>(req);
  const actor = actorOf(req);

  const invitation = await invitationService.invite({
    organisationId: actor.organisationId,
    invitedByMembershipId: actor.membershipId,
    email: input.email,
    roleId: input.roleId,
    scopeId: input.scopeId,
    seatId: input.seatId,
  });

  res.status(201).json({ invitation: presentInvitation(invitation.invitation) });
}

export async function listInvitations(req: Request, res: Response): Promise<void> {
  const invitations = await withTransaction((db) => invitationRepo.listPending(db));
  res.status(200).json({ invitations: invitations.map(presentInvitation) });
}

export async function revokeInvitation(req: Request, res: Response): Promise<void> {
  const { invitationId } = params<{ invitationId: string }>(req);
  const actor = actorOf(req);

  await invitationService.revoke({
    organisationId: actor.organisationId,
    actingMembershipId: actor.membershipId,
    invitationId,
  });

  res.status(204).end();
}

/**
 * The two unauthenticated invitation endpoints.
 *
 * THE INVITEE HAS NO TENANT AND CANNOT HAVE ONE — they are not a member yet, so
 * there is no organisation to scope their statements to. Both of these reach the
 * database through the `SECURITY DEFINER` functions in `002_auth.sql`, which is
 * the one deliberate hole in row level security in the whole schema: they take a
 * token, return one row, and pin their `search_path`.
 *
 * `preview` DELIBERATELY RETURNS ALMOST NOTHING — the organisation's name and
 * whether the token is usable. Anything more would make a leaked invitation link
 * a window into the tenant.
 */
export async function previewInvitation(req: Request, res: Response): Promise<void> {
  const { token } = query<{ token: string }>(req);
  const invitation = await invitationService.preview(token);

  /*
   * 404 RATHER THAN `200 null`. `preview` answers null for a token that names
   * nothing, and passing that straight through produced a JSON `null` body with
   * a success status — so a client had to null-check a 200 to find out whether
   * it had succeeded, and the page most likely to skip that check is the one an
   * anonymous invitee lands on.
   *
   * A FOUND-BUT-UNUSABLE INVITATION STILL ANSWERS 200, with its state. The two
   * cases genuinely differ for the reader: "this link was already used" is
   * something to explain, while "this link names nothing" is the same answer a
   * guessed token gets, and telling them apart would let somebody probe for
   * valid tokens by watching which ones come back 404.
   */
  if (!invitation) {
    throw notFound({
      message: 'That invitation link is not valid. Ask for a new one.',
      code: 'missing.invitation',
    });
  }

  res.status(200).json(invitation);
}

export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  // See `auth.controller.register` — the bot-check nonce stops here.
  const { turnstileToken: _ignored, ...input } = body<schema.AcceptInvitationBody>(req);

  const result = await invitationService.accept({
    ...input,
    context: { ip: clientIp(req), userAgent: userAgent(req) },
  });

  res.cookie(authConfig.cookie.name, result.sessionToken, {
    ...authConfig.cookie,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });

  res.status(200).json({
    token: result.sessionToken,
    membership: presentMembership(result.membership),
  });
}
