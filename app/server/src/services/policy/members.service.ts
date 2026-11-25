// Members (spec 55.7, 56.8): listing, suspension, removal and reinstatement.
//
// Any admin whose subtree contains a scope of the membership may suspend it, whoever
// issued its grants (member.suspend); only a super admin acts on a super admin, and nobody
// on themselves. In one transaction, suspension and removal:
// - set the status (the policy version bumps, so every cached decision is stale);
// - silence every live grant without revoking it (role assignments and the member's own
//   connection grants), so reinstatement restores the prior state;
// - revoke every session (through a definer function: sessions are auth's table) and end
//   every purpose session;
// - and removal also takes the scope memberships out of resolution, keeping the rows.
// The sessions' and purpose sessions' Redis copies go after the commit; Postgres is the
// revocation list, so a copy that outlives it for a moment is still refused on rebuild.
// Seats (chapter 72) and owned objects (views, crons, connections) belong to their
// services and are not touched here.

import { seatRepo } from '../../repos/billing/index.repo.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { membershipSessionKeys, purposeSessionKeys, sessionKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { automationRepo } from '../../repos/automation/index.repo.ts';
import { purposeDefinitionRepo, purposeSessionRepo } from '../../repos/gov/index.repo.ts';
import {
  connectionGrantRepo, membershipRepo, roleAssignmentRepo, scopeMembershipRepo, scopeRepo,
} from '../../repos/iam/index.repo.ts';
import type { MemberSummary } from '../../repos/iam/membership.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { administersMember } from './admin.service.ts';
import { auditActorOf, contextOf, demand, membershipOf, recordPolicyEvent, requireActor, type AdminDeps } from './deps.service.ts';

export interface LifecycleResult extends MemberSummary {
  grantsSilenced: number;
  grantsRestored: number;
  sessionsRevoked: number;
  purposeSessionsEnded: number;
}

export async function listMembers(deps: AdminDeps, ctx: HandlerContext, filter: { scopeId?: string | undefined; limit: number })
  : Promise<MemberSummary[]> {
  const subject = await requireActor(deps, ctx);
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor),
    (db) => membershipRepo.listWithScopes(db, { withinScopeId: filter.scopeId, limit: filter.limit }));
}

/** Every member's name and state and every live scope, for any member (sharing, and naming who did something). */
export async function directory(deps: AdminDeps, ctx: HandlerContext): Promise<{
  members: { membershipId: string; displayName: string; status: MemberSummary['status'] }[];
  scopes: { id: string; name: string; parentScopeId: string | null; depth: number }[];
}> {
  const subject = await requireActor(deps, ctx);
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), async (db) => ({
    members: (await membershipRepo.listWithScopes(db, { withinScopeId: undefined, limit: 5000 }))
      .map((m) => ({ membershipId: m.membershipId, displayName: m.displayName, status: m.status })),
    scopes: (await scopeRepo.list(db, false)).map((s) => ({ id: s.id, name: s.name, parentScopeId: s.parentScopeId, depth: s.depth })),
  }), { readOnly: true });
}

type Step = 'suspend' | 'remove' | 'reinstate';

export async function changeMember(deps: AdminDeps, ctx: HandlerContext, membershipId: string, step: Step): Promise<LifecycleResult> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  const organisationId = subject.actor.organisationId;
  const control = deps.databases.pool('control');
  if (actor === membershipId) throw new AppError('forbidden', 'you do not suspend, remove or reinstate yourself', { code: 'member.self' });
  const target = await inTransaction(control, contextOf(subject.actor), async (db) => ({
    membership: await membershipRepo.findById(db, membershipId),
    superAdmin: await roleAssignmentRepo.isSuperAdmin(db, organisationId, membershipId),
  }));
  if (!target.membership) throw new AppError('not_found', 'no such member', { code: 'member.not_found' });
  if (!await administersMember(deps, subject, membershipId, 'member.suspend')) {
    await demand(deps, ctx, subject, 'member.suspend', { organisationWide: true });
  }
  // A super admin answers to super admins only.
  if (target.superAdmin) await demand(deps, ctx, subject, 'member.suspend', { organisationWide: true });

  const status = target.membership.status;
  const allowed: Record<Step, string[]> = { suspend: ['active'], remove: ['active', 'suspended'], reinstate: ['suspended', 'removed'] };
  if (!allowed[step].includes(status)) {
    const done: Record<Step, string> = { suspend: 'suspended', remove: 'removed', reinstate: 'reinstated' };
    throw new AppError('conflict', `a ${status} member cannot be ${done[step]}`, {
      code: 'member.status', details: { status, step },
    });
  }

  const base = { organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), subjectMembershipId: membershipId,
    resource: { type: 'membership', id: membershipId } };
  const now = new Date().toISOString();
  const outcome = await inTransaction(control, contextOf(subject.actor), async (db) => {
    let grantsSilenced = 0;
    let grantsRestored = 0;
    let sessions: string[] = [];
    let purposes: string[] = [];
    if (step === 'reinstate') {
      // Restore what this member's suspension or removal silenced, before the status moves on.
      grantsRestored = await roleAssignmentRepo.restoreForMembership(db, membershipId) + await connectionGrantRepo.restoreForMembership(db, membershipId);
      if (status === 'removed') await scopeMembershipRepo.restoreForMembership(db, membershipId);
      await membershipRepo.update(db, membershipId, { status: 'active' });
      await recordPolicyEvent(db, { ...base, event: 'member_reinstated', detail: { from_status: status } });
      if (grantsRestored > 0) await recordPolicyEvent(db, { ...base, event: 'grants_restored', detail: { grant_count: grantsRestored } });
    } else {
      await membershipRepo.update(db, membershipId, step === 'suspend' ? { status: 'suspended', suspendedAt: now } : { status: 'removed', removedAt: now });
      // The same instant as suspended_at or removed_at, so reinstatement finds exactly what this step silenced.
      grantsSilenced = await roleAssignmentRepo.silenceForMembership(db, membershipId, now)
        + await connectionGrantRepo.silenceForMembership(db, membershipId, now);
      if (step === 'remove') await scopeMembershipRepo.deactivateForMembership(db, membershipId, now);
      // Suspension frees the seat for reassignment; removal leaves it untouched (spec 72.3, 72.4).
      const reclaimed = step === 'suspend' && await seatRepo.reclaimFrom(db, membershipId);
      sessions = await membershipRepo.revokeSessions(db, organisationId, membershipId);
      purposes = await purposeSessionRepo.endOpen(db, { membershipId }, step === 'remove' ? 'membership_removed' : 'session_revoked');
      // member_removed is read first: grants_silenced and the session revocation follow it in this transaction (spec 55.8).
      await recordPolicyEvent(db, { ...base, event: step === 'suspend' ? 'member_suspended' : 'member_removed', detail: { from_status: status } });
      if (grantsSilenced > 0) {
        await recordPolicyEvent(db, { ...base, event: 'grants_silenced', detail: { grant_count: grantsSilenced } });
        if (step === 'suspend') {
          await recordPolicyEvent(db, { ...base, event: 'membership_suspended_with_active_grants', detail: { grant_count: grantsSilenced } });
        }
      }
      if (sessions.length > 0) await recordPolicyEvent(db, { ...base, event: 'session_revoked', detail: { session_count: sessions.length } });
      if (reclaimed) await recordPolicyEvent(db, { ...base, event: 'seat_reclaimed', detail: { reason: 'suspended' } });
      if (purposes.length > 0) {
        await recordPolicyEvent(db, { ...base, event: 'purpose_session_ended', detail: { purpose_session_count: purposes.length, reason: step } });
      }
      if (step === 'remove') {
        // "A scheduled Action running under a removed person's authority is the specific thing an auditor looks for" (55.7):
        // their Crons pause now, not at their next firing.
        for (const cronId of await automationRepo.pauseForRemovedOwner(db, membershipId, now)) {
          await recordPolicyEvent(db, { ...base, event: 'cron_paused_on_removal', resource: { type: 'automation', id: cronId }, detail: { owner_membership_id: membershipId } });
        }
        // Purpose definitions they answered for go to a super admin.
        const heir = await roleAssignmentRepo.aSuperAdmin(db, membershipId);
        for (const definition of heir === undefined ? [] : await purposeDefinitionRepo.ownedBy(db, membershipId)) {
          await purposeDefinitionRepo.update(db, definition.id, { ownerMembershipId: heir!, version: definition.version + 1 });
          await recordPolicyEvent(db, {
            ...base, event: 'object_ownership_transferred', resource: { type: 'purpose_definition', id: definition.id },
            detail: { object_kind: 'purpose_definition', from_membership_id: membershipId, to_membership_id: heir!, reason: 'member_removed' },
          });
        }
      }
    }
    const [summary] = await membershipRepo.listWithScopes(db, { membershipId, limit: 1 });
    return { summary: summary!, grantsSilenced, grantsRestored, sessions, purposes };
  });

  // The hot copies, after the commit (spec 60.2).
  if (outcome.sessions.length > 0) {
    await deps.sessions.remove(sessionKeys, ...outcome.sessions.map((sessionId) => sessionKeys.key(organisationId, { sessionId }))).catch(() => undefined);
  }
  if (step !== 'reinstate') {
    await deps.sessions.remove(membershipSessionKeys, membershipSessionKeys.key(organisationId, { membershipId })).catch(() => undefined);
  }
  if (outcome.purposes.length > 0) {
    await deps.sessions.remove(purposeSessionKeys, ...outcome.purposes.map((purposeSessionId) =>
      purposeSessionKeys.key(organisationId, { purposeSessionId }))).catch(() => undefined);
  }
  // The member's saved views go to the admin above them (spec 37.10). The suspension stands
  // whatever happens here: a failed hand-over is logged, and the views stay with their owner.
  if (step !== 'reinstate' && deps.transferViews !== undefined) {
    await deps.transferViews(ctx.request, ctx.correlationId, membershipId, step === 'remove' ? 'member_removed' : 'member_suspended')
      .catch((error: unknown) => deps.logger.failure('the member\'s views were not handed over', error, {
        event: 'policy.views_transfer_failed', organisationId, resourceId: membershipId,
      }));
  }
  // Their apps follow the same rule (spec 37.7); a failed hand-over is logged and the apps stay put.
  if (step !== 'reinstate' && deps.transferApps !== undefined) {
    await deps.transferApps(ctx.request, ctx.correlationId, membershipId, step === 'remove' ? 'member_removed' : 'member_suspended')
      .catch((error: unknown) => deps.logger.failure('the member\'s apps were not handed over', error, {
        event: 'policy.apps_transfer_failed', organisationId, resourceId: membershipId,
      }));
  }
  // Connections they own go to the owning scope's admin or a super admin, on removal only (spec 55.7).
  if (step === 'remove' && deps.transferConnections !== undefined) {
    await deps.transferConnections(ctx.request, ctx.correlationId, membershipId)
      .catch((error: unknown) => deps.logger.failure('the member\'s connections were not handed over', error, {
        event: 'policy.connections_transfer_failed', organisationId, resourceId: membershipId,
      }));
  }
  return {
    ...outcome.summary, grantsSilenced: outcome.grantsSilenced, grantsRestored: outcome.grantsRestored,
    sessionsRevoked: outcome.sessions.length, purposeSessionsEnded: outcome.purposes.length,
  };
}
