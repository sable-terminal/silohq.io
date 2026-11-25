import type { Request, Response } from 'express';
import * as scopeService from '../services/scope.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import { presentScope, presentScopeTree, presentScopeType } from './present';
import type * as schema from '../schemas/scope.schema';

/**
 * The organisation's own tree.
 *
 * THESE CONTROLLERS ARE THIN AND THAT IS DELIBERATE. Every authorisation
 * decision about a scope depends on where in the tree it sits, and the tree is
 * read inside the service's transaction — so the check and the write see the same
 * state. Lifting any of it up here would mean reading the tree once for the check
 * and again for the write, with a window between them in which the scope moves
 * and the check no longer describes what happened.
 */

export async function listTypes(req: Request, res: Response): Promise<void> {
  const types = await scopeService.listTypes(actorOf(req));
  res.status(200).json({ scopeTypes: types.map(presentScopeType) });
}

export async function createType(req: Request, res: Response): Promise<void> {
  const type = await scopeService.createType(actorOf(req), body<schema.CreateScopeTypeBody>(req));
  res.status(201).json({ scopeType: presentScopeType(type) });
}

/**
 * The whole tree, in one response.
 *
 * NOT PAGINATED, AND THAT IS A JUDGEMENT ABOUT THE DATA RATHER THAN AN OVERSIGHT.
 * A scope tree is capped at twelve deep and is a structural description of an
 * organisation, not a data set — hundreds of nodes, not millions. Paginating it
 * would mean returning a fragment of a tree, which is not a tree, and every
 * client would have to reassemble it before it could draw anything.
 */
export async function tree(req: Request, res: Response): Promise<void> {
  res.status(200).json({ scopes: presentScopeTree(await scopeService.tree(actorOf(req))) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const scope = await scopeService.create(actorOf(req), body<schema.CreateScopeBody>(req));
  res.status(201).json({ scope: presentScope(scope) });
}

/**
 * Moving a scope moves everything under it.
 *
 * ANSWERS WITH THE MOVED SCOPE'S NEW PATH so the client can see what happened.
 * The descendants' paths were rewritten in the same transaction by the trigger in
 * `003_scopes.sql`; a client holding a stale tree should refetch, which the new
 * path makes visibly necessary.
 */
export async function move(req: Request, res: Response): Promise<void> {
  const { scopeId } = params<{ scopeId: string }>(req);
  const { newParentId } = body<schema.MoveScopeBody>(req);

  const scope = await scopeService.move(actorOf(req), { scopeId, newParentId });
  res.status(200).json({ scope: presentScope(scope) });
}

/** Archive, never delete. A deleted scope takes its audit history with it. */
export async function archive(req: Request, res: Response): Promise<void> {
  const { scopeId } = params<{ scopeId: string }>(req);
  await scopeService.archive(actorOf(req), scopeId);
  res.status(204).end();
}

export async function addMember(req: Request, res: Response): Promise<void> {
  const { scopeId } = params<{ scopeId: string }>(req);
  const { membershipId, isPrimary } = body<schema.AddScopeMemberBody>(req);

  await scopeService.addMember(actorOf(req), { scopeId, membershipId, isPrimary });
  res.status(204).end();
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  const { scopeId, membershipId } = params<{ scopeId: string; membershipId: string }>(req);
  await scopeService.removeMember(actorOf(req), { scopeId, membershipId });
  res.status(204).end();
}

/**
 * Who is in a scope, and who can act there.
 *
 * BOTH IN ONE RESPONSE. Being IN a scope is where a person's work sits; holding
 * a role AT it is what they may do there. An interface that fetched one and
 * labelled it "people" would be wrong in a way nobody notices until a
 * permission review.
 */
export async function members(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await scopeService.members(actorOf(req), id));
}
