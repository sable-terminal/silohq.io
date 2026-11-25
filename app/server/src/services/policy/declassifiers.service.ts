// Declassifiers (spec 58.10; decision 2026-11-14; D81): a membership, or a scope's members,
// named for a marking as able to request its declassification. A super admin (clearance.grant,
// never delegable) names one with a justification; a second person holding clearance.grant
// approves it before it counts; either may revoke it. The grant is append-only and apart
// from roles. Requesting still needs the requester to satisfy the marking, and approving a
// declassification still needs another person who does (58.9).

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { DeclassifierMembership } from '../../models/gov/declassifierMembership.model.ts';
import { declassifierMembershipRepo, markingRepo } from '../../repos/gov/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { auditActorOf, contextOf, demand, membershipOf, recordPolicyEvent, requireActor, type AdminDeps } from './deps.service.ts';

export const declassifierView = (d: DeclassifierMembership) => ({
  id: d.id, markingId: d.markingId, grantee: d.membershipId !== null ? { kind: 'membership' as const, id: d.membershipId } : { kind: 'scope' as const, id: d.scopeId! },
  justification: d.justification, grantedBy: d.grantedBy, grantedAt: d.grantedAt, approvedBy: d.approvedBy, approvedAt: d.approvedAt,
  expiresAt: d.expiresAt, revokedAt: d.revokedAt,
  status: d.revokedAt !== null ? 'revoked' as const : d.approvedAt === null ? 'awaiting_approval' as const
    : d.expiresAt !== null && Date.parse(d.expiresAt) <= Date.now() ? 'expired' as const : 'active' as const,
});

async function start(deps: AdminDeps, ctx: HandlerContext) {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  const at = { organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor) };
  return { subject, membershipId: membershipOf(subject), at, tx: <T>(work: Parameters<typeof inTransaction<T>>[2]) =>
    inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work) };
}

export async function grantDeclassifier(deps: AdminDeps, ctx: HandlerContext, input: {
  markingId: string; grantee: { kind: 'membership' | 'scope'; id: string }; justification: string; expiresAt?: string | undefined;
}) {
  const { membershipId, at, tx } = await start(deps, ctx);
  return tx(async (db) => {
    const marking = await markingRepo.findById(db, input.markingId);
    if (!marking || marking.retiredAt !== null) throw new AppError('not_found', 'no such marking', { code: 'marking.not_found' });
    const row = await declassifierMembershipRepo.insert(db, {
      id: uuidv7(), organisationId: at.organisationId, markingId: input.markingId,
      membershipId: input.grantee.kind === 'membership' ? input.grantee.id : null, scopeId: input.grantee.kind === 'scope' ? input.grantee.id : null,
      justification: input.justification, grantedBy: membershipId, expiresAt: input.expiresAt ?? null,
    });
    await recordPolicyEvent(db, { ...at, event: 'declassifier_granted', resource: { type: 'declassifier_membership', id: row.id },
      detail: { marking_id: input.markingId, grantee: input.grantee.kind } });
    return declassifierView(row);
  });
}

export async function approveDeclassifier(deps: AdminDeps, ctx: HandlerContext, id: string) {
  const { membershipId, at, tx } = await start(deps, ctx);
  return tx(async (db) => {
    const row = await declassifierMembershipRepo.findById(db, id);
    if (!row) throw new AppError('not_found', 'no such declassifier grant', { code: 'declassifier.not_found' });
    if (row.grantedBy === membershipId) {
      throw new AppError('forbidden', 'you named them; a second person approves it', { code: 'declassifier.self_approval' });
    }
    if (!await declassifierMembershipRepo.approve(db, id, membershipId)) {
      throw new AppError('conflict', 'it is already approved or revoked', { code: 'declassifier.not_pending' });
    }
    await recordPolicyEvent(db, { ...at, event: 'declassifier_approved', resource: { type: 'declassifier_membership', id },
      detail: { marking_id: row.markingId } });
    return declassifierView((await declassifierMembershipRepo.findById(db, id))!);
  });
}

export async function revokeDeclassifier(deps: AdminDeps, ctx: HandlerContext, id: string) {
  const { membershipId, at, tx } = await start(deps, ctx);
  return tx(async (db) => {
    const row = await declassifierMembershipRepo.findById(db, id);
    if (!row) throw new AppError('not_found', 'no such declassifier grant', { code: 'declassifier.not_found' });
    if (await declassifierMembershipRepo.revoke(db, id, membershipId)) {
      await recordPolicyEvent(db, { ...at, event: 'declassifier_revoked', resource: { type: 'declassifier_membership', id },
        detail: { marking_id: row.markingId } });
    }
    return declassifierView((await declassifierMembershipRepo.findById(db, id))!);
  });
}

export async function listDeclassifiers(deps: AdminDeps, ctx: HandlerContext, markingId: string | undefined) {
  const { tx } = await start(deps, ctx);
  return { declassifiers: (await tx((db) => declassifierMembershipRepo.list(db, markingId))).map(declassifierView) };
}
