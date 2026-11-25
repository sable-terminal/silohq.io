// Apps of a removed or suspended member (spec 37.7, the rule views follow; workspace's
// transfer.service.ts for views).
//
// The receiver is the same admin the member's views go to: the nearest admin above the
// member's scopes, the primary scope's where they differ, a super admin where none applies.
// In one transaction each live app the member owns moves to the receiver, flagged, its live
// shares suspended; shares of other people's apps made to the member are revoked. A flag is
// resolved, never deleted.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { appRepo, appShareRepo, appTransferFlagRepo, viewTransferFlagRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { member, recordEvent, recordServiceEvent, type Context, type StudioDeps } from './deps.service.ts';

type Reason = 'member_removed' | 'member_suspended' | 'scope_archived';

/** Called by policy when it removes or suspends a membership. */
export async function transferApps(deps: StudioDeps, ctx: Context, membershipId: string, reason: Reason) {
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const now = new Date().toISOString();
    const revokedToMember = reason === 'scope_archived' ? 0 : await appShareRepo.revokeToMembership(db, membershipId, now);
    const apps = await appRepo.ownedLiveForUpdate(db, membershipId);
    if (apps.length === 0) return { receivingMembershipId: null, appsTransferred: 0, sharesSuspended: 0, sharesRevoked: revokedToMember };
    const nearest = await viewTransferFlagRepo.nearestAdmins(db, membershipId);
    const distinct = new Set(nearest.map((n) => n.adminId));
    const receiver = distinct.size === 1 ? nearest[0]!.adminId
      : distinct.size > 1 ? (nearest.find((n) => n.isPrimary) ?? [...nearest].sort((a, b) => b.depth - a.depth)[0]!).adminId
        : await viewTransferFlagRepo.aSuperAdmin(db, membershipId);
    if (receiver === undefined) {
      deps.logger.warn('no admin to receive a removed member\'s apps', { event: 'studio.transfer_no_receiver', membershipId, count: apps.length });
      return { receivingMembershipId: null, appsTransferred: 0, sharesSuspended: 0, sharesRevoked: revokedToMember };
    }
    let suspended = 0;
    for (const app of apps) {
      suspended += await appShareRepo.suspendLive(db, app.id, now);
      await appRepo.update(db, app.id, { ownerMembershipId: receiver, transferredFromMembershipId: membershipId, transferredAt: now });
      await appTransferFlagRepo.insert(db, { id: uuidv7(), organisationId, appId: app.id, transferredTo: receiver, transferredFrom: membershipId, reason });
      await recordServiceEvent(db, organisationId, ctx.correlationId, {
        event: 'app_transferred', resource: { type: 'app', id: app.id }, subjectMembershipId: receiver, detail: { from: membershipId, reason, shares_suspended: suspended },
      });
    }
    return { receivingMembershipId: receiver, appsTransferred: apps.length, sharesSuspended: suspended, sharesRevoked: revokedToMember };
  });
}

export async function inheritedApps(deps: StudioDeps, ctx: Context) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const out = [];
    for (const flag of await appTransferFlagRepo.listOpenFor(db, me.membershipId)) {
      const app = await appRepo.findById(db, flag.appId);
      if (!app || app.ownerMembershipId !== me.membershipId) continue;
      out.push({ flagId: flag.id, appId: app.id, name: app.name, transferredFrom: flag.transferredFrom, reason: flag.reason, createdAt: flag.createdAt });
    }
    return { inherited: out };
  }, { readOnly: true });
}

/** The receiving admin's decision: share onward (suspended shares resume), retain privately (revoked), or archive (revoked, archived). */
export async function reviewInheritedApp(deps: StudioDeps, ctx: Context, flagId: string, decision: 'shared' | 'retained' | 'archived') {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const flag = await appTransferFlagRepo.findById(db, flagId);
    if (!flag || flag.transferredTo !== me.membershipId) throw new AppError('not_found', 'no such inherited app', { code: 'studio.transfer_not_found' });
    if (flag.reviewedAt !== null) throw new AppError('conflict', 'this inherited app was already reviewed', { code: 'studio.transfer_reviewed' });
    const app = await appRepo.findForUpdate(db, flag.appId);
    if (!app || app.ownerMembershipId !== me.membershipId) throw new AppError('not_found', 'no such inherited app', { code: 'studio.transfer_not_found' });
    const now = new Date().toISOString();
    const resumed = decision === 'shared' ? await appShareRepo.resumeSuspended(db, app.id) : 0;
    const revoked = decision === 'shared' ? 0 : await appShareRepo.revokeAll(db, app.id, now);
    if (decision === 'archived') await appRepo.update(db, app.id, { archivedAt: now });
    await appTransferFlagRepo.update(db, flag.id, { reviewedAt: now, decision });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_transfer_reviewed', resource: { type: 'app', id: app.id }, subjectMembershipId: flag.transferredFrom,
      detail: { decision, shares_resumed: resumed, shares_revoked: revoked },
    });
    return { appId: app.id, decision, sharesResumed: resumed, sharesRevoked: revoked };
  });
}
