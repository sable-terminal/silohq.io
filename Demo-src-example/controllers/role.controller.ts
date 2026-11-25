import type { Request, Response } from 'express';
import * as roleService from '../services/role.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import { presentAssignment, presentMarking, presentPermission, presentRole } from './present';
import type * as schema from '../schemas/role.schema';

/**
 * Roles, grants, and the things that cannot be granted.
 *
 * THE PERMISSION CATALOGUE IS READABLE BY ANY MEMBER. It is the vocabulary, not
 * the assignment — knowing that `mutation.approve` exists tells you nothing about
 * who holds it, and hiding it would mean an interface that cannot explain to
 * somebody why they were refused or what to ask for.
 */

export async function listRoles(req: Request, res: Response): Promise<void> {
  const roles = await roleService.listRoles(actorOf(req));
  res.status(200).json({ roles: roles.map(presentRole) });
}

export async function listPermissions(req: Request, res: Response): Promise<void> {
  const permissions = await roleService.listPermissions(actorOf(req));
  res.status(200).json({ permissions: permissions.map(presentPermission) });
}

/**
 * Granting a role.
 *
 * THE SERVICE CHECKS THE DELEGATION RULES AND THIS DOES NOT. Whether you may
 * grant *this* role at *this* scope depends on which roles yours may grant, on
 * whether the scope is beneath one you administer, and on whether the grant
 * would exceed your own authority — three questions that need the same
 * transaction as the write. The `role.grant` permission checked in the router is
 * only the coarse "may you grant anything at all".
 */
export async function grant(req: Request, res: Response): Promise<void> {
  const input = body<schema.GrantRoleBody>(req);

  const assignment = await roleService.grant(actorOf(req), {
    targetMembershipId: input.targetMembershipId,
    roleId: input.roleId,
    scopeId: input.scopeId,
    expiresAt: input.expiresAt,
  });

  res.status(201).json({ assignment: presentAssignment(assignment) });
}

export async function grantPrincipal(req: Request, res: Response): Promise<void> {
  const input = body<schema.GrantToPrincipalBody>(req);

  const assignment = await roleService.grantToPrincipal(actorOf(req), {
    principalId: input.principalId,
    roleId: input.roleId,
    scopeId: input.scopeId,
    expiresAt: input.expiresAt,
  });

  res.status(201).json({ assignment: presentAssignment(assignment) });
}

export async function revoke(req: Request, res: Response): Promise<void> {
  const { assignmentId } = params<{ assignmentId: string }>(req);
  await roleService.revoke(actorOf(req), assignmentId);
  res.status(204).end();
}

/**
 * What a departing administrator leaves behind.
 *
 * THE QUESTION NOBODY THINKS TO ASK UNTIL IT MATTERS. An admin who granted forty
 * roles and then left means forty grants whose granter no longer has the
 * authority that justified them — still live, still conferring access, and
 * invisible to anyone reviewing the current roster. This makes them countable at
 * the moment the departure happens.
 */
export async function orphanedGrants(req: Request, res: Response): Promise<void> {
  const { membershipId } = params<{ membershipId: string }>(req);
  const grants = await roleService.orphanedGrants(actorOf(req), membershipId);
  res.status(200).json({ assignments: grants.map(presentAssignment) });
}

/* ── Markings and clearances ────────────────────────────────────────────── */

/**
 * MARKINGS ARE THE MANDATORY GATE AND ROLES ARE THE DISCRETIONARY ONE. A role
 * grants; a marking withholds. Holding every permission in the organisation does
 * not open a marked resource without the matching clearance, which is why
 * defining a marking is a super-admin act — it is the only way to put something
 * beyond the reach of a permission.
 */
export async function listMarkings(req: Request, res: Response): Promise<void> {
  const markings = await roleService.listMarkings(actorOf(req));
  res.status(200).json({ markings: markings.map(presentMarking) });
}

export async function createMarking(req: Request, res: Response): Promise<void> {
  const marking = await roleService.createMarking(actorOf(req), body<schema.CreateMarkingBody>(req));
  res.status(201).json({ marking: presentMarking(marking) });
}

export async function grantClearance(req: Request, res: Response): Promise<void> {
  const input = body<schema.GrantClearanceBody>(req);

  await roleService.grantClearance(actorOf(req), {
    targetMembershipId: input.targetMembershipId,
    markingId: input.markingId,
    expiresAt: input.expiresAt,
  });

  res.status(204).end();
}

export async function revokeClearance(req: Request, res: Response): Promise<void> {
  const { membershipId, markingId } = params<{ membershipId: string; markingId: string }>(req);

  await roleService.revokeClearance(actorOf(req), {
    targetMembershipId: membershipId,
    markingId,
  });

  res.status(204).end();
}
