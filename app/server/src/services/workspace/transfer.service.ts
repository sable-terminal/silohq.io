// Views of a removed member (spec 37.7, 37.10).
//
// The receiving admin: for each scope the member belonged to (active, or made inactive by
// the removal), the nearest admin above it (an active member holding admin.delegate on a
// scope containing it). If every scope gives the same admin, that one; if they differ, the
// admin of the member's primary scope; if the primary has none, the nearest across all;
// where no scope admin applies, a super admin.
//
// In one transaction: each live view moves to the receiver, flagged, its live shares
// suspended and its tiles and favourite cleared; its thread moves with it; the member's
// other threads are archived; shares made to the member are revoked. A flag is resolved,
// never deleted.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { askThreadRepo, dashboardTileRepo, savedViewRepo, viewShareRepo, viewTransferFlagRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { member, recordEvent, type Context, type WorkspaceDeps } from './deps.service.ts';
import { refreshVisibility } from './sharing.service.ts';
import { viewOf } from './views.service.ts';
import type { SavedViewView } from '../../contracts/workspace/view.contract.ts';

export type TransferReason = 'member_removed' | 'member_suspended' | 'scope_archived';

export interface TransferResult {
  receivingMembershipId: string | null;
  viewsTransferred: number;
  sharesSuspended: number;
  sharesRevoked: number;
  threadsArchived: number;
}

/** Called by policy when it removes or suspends a membership. */
export async function transfer(deps: WorkspaceDeps, ctx: Context, membershipId: string, reason: TransferReason): Promise<TransferResult> {
  const organisationId = ctx.request.organisationId!;
  const who = { organisationId, service: 'workspace' as const };
  return inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const now = new Date().toISOString();
    // Shares to the departing member stop at once, whoever owns the view (spec 37.10).
    const revokedToMember = reason === 'scope_archived' ? 0 : await viewShareRepo.revokeToMembership(db, membershipId, now);
    const views = await savedViewRepo.ownedLiveForUpdate(db, membershipId);
    if (views.length === 0) {
      return { receivingMembershipId: null, viewsTransferred: 0, sharesSuspended: 0, sharesRevoked: revokedToMember, threadsArchived: 0 };
    }

    const nearest = await viewTransferFlagRepo.nearestAdmins(db, membershipId);
    const distinct = new Set(nearest.map((n) => n.adminId));
    const receiver = distinct.size === 1 ? nearest[0]!.adminId
      : distinct.size > 1 ? (nearest.find((n) => n.isPrimary) ?? [...nearest].sort((a, b) => b.depth - a.depth)[0]!).adminId
        : await viewTransferFlagRepo.aSuperAdmin(db, membershipId);
    if (receiver === undefined) {
      // Nobody accountable to receive them: the views stay put, and the departure is logged.
      deps.logger.warn('no admin to receive a removed member\'s views', { event: 'workspace.transfer_no_receiver', membershipId, count: views.length });
      return { receivingMembershipId: null, viewsTransferred: 0, sharesSuspended: 0, sharesRevoked: revokedToMember, threadsArchived: 0 };
    }

    let suspended = 0;
    for (const view of views) {
      suspended += await viewShareRepo.suspendLive(db, view.id, now);
      await dashboardTileRepo.removeForView(db, view.id, membershipId);
      const moved = (await savedViewRepo.update(db, view.id, {
        ownerMembershipId: receiver, transferredFromMembershipId: membershipId, transferredAt: now, favourited: false,
      }))!;
      await refreshVisibility(db, moved);
      await viewTransferFlagRepo.insert(db, {
        id: uuidv7(), organisationId, savedViewId: view.id, transferredTo: receiver, transferredFrom: membershipId, reason,
      });
      await recordEvent(db, who, ctx.correlationId, {
        event: 'view_transferred', resource: { type: 'view', id: view.id }, subjectMembershipId: receiver,
        detail: { from: membershipId, reason },
      });
    }
    if (suspended > 0) {
      await recordEvent(db, who, ctx.correlationId, {
        event: 'view_share_suspended', resource: null, subjectMembershipId: receiver, detail: { shares: suspended, views: views.length },
      });
    }
    await askThreadRepo.transferViewThreads(db, views.map((v) => v.id), receiver);
    const archived = reason === 'scope_archived' ? 0 : await askThreadRepo.archiveOthersOf(db, membershipId, now);
    return {
      receivingMembershipId: receiver, viewsTransferred: views.length, sharesSuspended: suspended, sharesRevoked: revokedToMember,
      threadsArchived: archived,
    };
  });
}

export interface InheritedView {
  flagId: string;
  view: SavedViewView;
  transferredFrom: string;
  reason: TransferReason;
  createdAt: string;
}

export async function inherited(deps: WorkspaceDeps, ctx: Context): Promise<InheritedView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const out: InheritedView[] = [];
    for (const flag of await viewTransferFlagRepo.listOpenFor(db, me.membershipId)) {
      const view = await savedViewRepo.findById(db, flag.savedViewId!);
      if (!view || view.ownerMembershipId !== me.membershipId) continue;
      out.push({ flagId: flag.id, view: viewOf(view, 'owner'), transferredFrom: flag.transferredFrom, reason: flag.reason, createdAt: flag.createdAt });
    }
    return out;
  }, { readOnly: true });
}

/**
 * The receiving admin's decision: share onward (the suspended shares resume, still subject
 * to the admin's own sharing policy at resolution), retain privately (they are revoked), or
 * archive (revoked, and the view archived). Reviewing never resumes a Cron (spec 37.7).
 */
export async function review(deps: WorkspaceDeps, ctx: Context, flagId: string, decision: 'shared' | 'retained' | 'archived')
  : Promise<{ view: SavedViewView; decision: typeof decision; sharesResumed: number; sharesRevoked: number }> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const flag = await viewTransferFlagRepo.findById(db, flagId);
    if (!flag || flag.transferredTo !== me.membershipId || flag.savedViewId === null) {
      throw new AppError('not_found', 'no such inherited view', { code: 'workspace.transfer_not_found' });
    }
    if (flag.reviewedAt !== null) throw new AppError('conflict', 'this inherited view was already reviewed', { code: 'workspace.transfer_reviewed' });
    const view = await savedViewRepo.findForUpdate(db, flag.savedViewId);
    if (!view || view.ownerMembershipId !== me.membershipId) throw new AppError('not_found', 'no such inherited view', { code: 'workspace.transfer_not_found' });
    const now = new Date().toISOString();
    let resumed = 0;
    let revoked = 0;
    let row = view;
    if (decision === 'shared') resumed = await viewShareRepo.resumeSuspended(db, view.id);
    else revoked = await viewShareRepo.revokeAll(db, view.id, now);
    if (decision === 'archived') row = (await savedViewRepo.update(db, view.id, { archivedAt: now, favourited: false }))!;
    row = await refreshVisibility(db, row);
    await viewTransferFlagRepo.update(db, flag.id, { reviewedAt: now, decision });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'view_transfer_reviewed', resource: { type: 'view', id: view.id }, subjectMembershipId: flag.transferredFrom,
      detail: { decision, shares_resumed: resumed, shares_revoked: revoked },
    });
    return { view: viewOf(row, 'owner'), decision, sharesResumed: resumed, sharesRevoked: revoked };
  });
}
