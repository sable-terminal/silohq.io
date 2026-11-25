// Following (spec 33.7; decision 2026-11-17): a person follows a Cron or a saved view of an
// object set that someone else owns, so its runs, or the findings on its objects, reach
// their Home. What they own they follow already, without a row.
//
// Following grants nothing: the person must be able to read the Cron (its owner shared it
// with them, or they manage Crons) or open the view when they choose to follow it, and the
// briefing resolves access again each time it is read, so a follow of something they can no
// longer see shows nothing. A follow ends when its Cron is deleted or its view archived.

import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { getCron } from '../../contracts/scheduler/cron.contract.ts';
import type { FollowView } from '../../contracts/workspace/shell.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Follow } from '../../models/workspace/follow.model.ts';
import { followRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { member, type Context, type WorkspaceDeps } from './deps.service.ts';
import { read as readView } from './views.service.ts';

const followOf = (row: Follow): FollowView => ({ id: row.id, resourceType: row.resourceType, resourceId: row.resourceId, createdAt: row.createdAt });

const notFound = (): AppError => new AppError('not_found', 'there is nothing you can see to follow there', { code: 'workspace.follow_target_not_found' });

/** Who owns what is to be followed, checked as the person: their own access decides. */
async function ownerOf(deps: WorkspaceDeps, ctx: Context, resourceType: 'cron' | 'view', resourceId: string): Promise<string> {
  try {
    if (resourceType === 'cron') {
      const cron = await deps.services.call(getCron, { params: { cronId: resourceId } }, { request: ctx.request, correlationId: ctx.correlationId });
      return cron.ownerMembershipId;
    }
    const view = await readView(deps, ctx, resourceId);
    if (view.kind !== 'object_set' || view.objectSetId === null) {
      throw new AppError('validation', 'only a saved object set is followed: its findings reach your Home', { code: 'workspace.follow_not_object_set' });
    }
    // The briefing finds the set's objects by its definition, read as the person: a set private
    // to its owner would follow nothing, so it is refused now, saying what would allow it.
    await deps.services.call(getObjectSet, { params: { objectSetId: view.objectSetId } }, { request: ctx.request, correlationId: ctx.correlationId })
      .catch((error: unknown) => {
        if (isAppError(error) && error.category === 'not_found') {
          throw new AppError('validation', 'the view\'s object set is private to its owner: they can share the set so you can follow it', {
            code: 'workspace.follow_set_private',
          });
        }
        throw error;
      });
    return view.ownerMembershipId;
  } catch (error) {
    if (isAppError(error) && error.category === 'not_found') throw notFound();
    throw error;
  }
}

export async function follow(deps: WorkspaceDeps, ctx: Context, input: { resourceType: 'cron' | 'view'; resourceId: string }): Promise<FollowView> {
  const me = member(ctx);
  const owner = await ownerOf(deps, ctx, input.resourceType, input.resourceId);
  if (owner === me.membershipId) {
    throw new AppError('validation', 'you follow what you own already', { code: 'workspace.follow_own' });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const key = { organisationId: me.organisationId, membershipId: me.membershipId, resourceType: input.resourceType, resourceId: input.resourceId };
    const existing = await followRepo.findByMembershipIdAndResourceTypeAndResourceId(db, key);
    return followOf(existing ?? await followRepo.insert(db, { id: uuidv7(), ...key }));
  });
}

export async function unfollow(deps: WorkspaceDeps, ctx: Context, followId: string): Promise<FollowView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await followRepo.findById(db, followId);
    if (!row || row.membershipId !== me.membershipId) throw new AppError('not_found', 'no such follow', { code: 'workspace.follow_not_found' });
    await followRepo.remove(db, row.id);
    return followOf(row);
  });
}

export async function follows(deps: WorkspaceDeps, ctx: Context): Promise<FollowView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => (await followRepo.listForMember(db, me.membershipId)).map(followOf),
    { readOnly: true });
}
