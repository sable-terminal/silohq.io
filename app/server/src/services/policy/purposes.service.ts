// Purposes (spec 58.5): eligibility is not enough. A person declares a purpose, bound to an
// approved purpose definition, and purpose-marked data is reachable only within the
// resulting purpose session, named by each request that runs under it.
//
// - Definitions are created, approved (by a holder of purpose.define who is not the
//   creator), suspended and retired organisation-wide (purpose.define). Suspending or
//   retiring one ends its open purpose sessions in the same transaction.
// - Eligibility is granted and revoked with clearance.grant; revoking one ends the
//   sessions whose declarer is no longer eligible, in the same transaction.
// - Declaring needs eligibility, which is what purpose.declare means (spec 58.10: held by
//   any eligible membership), not a role.
// - A purpose session is bound to the authentication session it was declared in, lasts at
//   most the definition's limit and never outlives that session, and is never renewed in
//   place. Its hot copy is in redis-session; Postgres is the record.
// - A definition's use (decision 2026-11-14; D81): analysis needs no approval; export,
//   sharing outside the organisation, write-back and marked data in AI or simulation outputs
//   do. A declaration of such a definition reaches nothing until a holder of purpose.define
//   other than the declarer approves it, within its time; only then is its hot copy written.

import type { HandlerContext } from '../../infra/http.infra.ts';
import { purposeSessionKeys, sessionKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { markingRepo, purposeDefinitionRepo, purposeEligibilityRepo, purposeSessionRepo } from '../../repos/gov/index.repo.ts';
import type { PurposeDefinition } from '../../models/gov/purposeDefinition.model.ts';
import type { PurposeEligibility } from '../../models/gov/purposeEligibility.model.ts';
import type { PurposeSession } from '../../models/gov/purposeSession.model.ts';
import type { Grantee } from '../../contracts/policy/governance.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  auditActorOf, contextOf, demand, isCheckViolation, isUniqueViolation, membershipOf, recordPolicyEvent, requireActor, type AdminDeps,
} from './deps.service.ts';
import type { Subject } from './policy.service.ts';

const tx = <T>(deps: AdminDeps, subject: Subject, work: (db: Queryable) => Promise<T>): Promise<T> =>
  inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work);

const event = (ctx: HandlerContext, subject: Subject) => ({
  organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
});

const DAY_SECONDS = 86_400;

export type PurposeUse = 'analysis' | 'export' | 'external_sharing' | 'write_back' | 'ai_or_simulation';

async function dropCopies(deps: AdminDeps, organisationId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await deps.sessions.remove(purposeSessionKeys, ...ids.map((purposeSessionId) => purposeSessionKeys.key(organisationId, { purposeSessionId })))
    .catch(() => undefined);
}

// ----------------------------------------------------------------------------- definitions

export async function createPurposeDefinition(deps: AdminDeps, ctx: HandlerContext, input: { markingId: string; name: string;
  description: string; lawfulBasis?: string | undefined; maxSessionMinutes: number; requiresJustification: boolean;
  requiresApproval: boolean; use?: PurposeUse | undefined }): Promise<PurposeDefinition> {
  const use = input.use ?? 'analysis';
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  await demand(deps, ctx, subject, 'purpose.define', { organisationWide: true });
  try {
    return await tx(deps, subject, async (db) => {
      const marking = await markingRepo.findById(db, input.markingId);
      if (!marking || marking.retiredAt !== null || marking.kind !== 'purpose') {
        throw new AppError('validation', 'a purpose definition is bound to a live purpose marking', { code: 'purpose.marking_invalid' });
      }
      const row = await purposeDefinitionRepo.insert(db, {
        id: uuidv7(), organisationId: subject.actor.organisationId, markingId: marking.id, name: input.name, description: input.description,
        lawfulBasis: input.lawfulBasis ?? null, maxSessionMinutes: input.maxSessionMinutes, requiresJustification: input.requiresJustification,
        requiresApproval: input.requiresApproval || use !== 'analysis', use, createdBy: actor, ownerMembershipId: actor,
      });
      await recordPolicyEvent(db, { ...event(ctx, subject), event: 'purpose_defined', resource: { type: 'purpose_definition', id: row.id },
        detail: { marking_id: marking.id, max_session_minutes: row.maxSessionMinutes } });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'that purpose marking already has a live definition', { code: 'purpose.exists' });
    throw error;
  }
}

export async function approvePurposeDefinition(deps: AdminDeps, ctx: HandlerContext, id: string, input: { version: number;
  reviewDueAt?: string | undefined }): Promise<PurposeDefinition> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  await demand(deps, ctx, subject, 'purpose.define', { organisationWide: true });
  try {
    return await tx(deps, subject, async (db) => {
      const before = await purposeDefinitionRepo.findById(db, id);
      if (!before) throw new AppError('not_found', 'no such purpose definition', { code: 'purpose.not_found' });
      if (before.createdBy === actor) throw new AppError('forbidden', 'a purpose is approved by someone other than its author', { code: 'purpose.self_approval' });
      if (before.status === 'approved') return before;
      if (before.status === 'retired') throw new AppError('conflict', 'a retired purpose is not approved again', { code: 'purpose.retired' });
      const row = await purposeDefinitionRepo.updateAtVersion(db, id, input.version, {
        status: 'approved', approvedBy: actor, approvedAt: new Date().toISOString(), reviewDueAt: input.reviewDueAt ?? null,
      });
      if (!row) throw new AppError('conflict', 'the purpose changed since it was read', { code: 'purpose.stale' });
      await recordPolicyEvent(db, { ...event(ctx, subject), event: 'purpose_approved', resource: { type: 'purpose_definition', id } });
      return row;
    });
  } catch (error) {
    if (isCheckViolation(error)) throw new AppError('forbidden', 'a purpose is approved by someone other than its author', { code: 'purpose.self_approval' });
    throw error;
  }
}

export async function setPurposeDefinitionStatus(deps: AdminDeps, ctx: HandlerContext, id: string, input: { version: number;
  status: 'suspended' | 'retired' }): Promise<PurposeDefinition> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'purpose.define', { organisationWide: true });
  const { row, ended } = await tx(deps, subject, async (db) => {
    const before = await purposeDefinitionRepo.findById(db, id);
    if (!before) throw new AppError('not_found', 'no such purpose definition', { code: 'purpose.not_found' });
    if (before.status === input.status) return { row: before, ended: [] as string[] };
    if (before.status === 'retired') throw new AppError('conflict', 'a retired purpose does not change', { code: 'purpose.retired' });
    if (input.status === 'suspended' && before.status !== 'approved') {
      throw new AppError('conflict', 'only an approved purpose is suspended', { code: 'purpose.status' });
    }
    // Every open session of it ends here; the deferred check refuses the commit otherwise.
    const endedIds = await purposeSessionRepo.endOpen(db, { purposeDefinitionId: id }, 'definition_suspended');
    const updated = await purposeDefinitionRepo.updateAtVersion(db, id, input.version, { status: input.status });
    if (!updated) throw new AppError('conflict', 'the purpose changed since it was read', { code: 'purpose.stale' });
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: input.status === 'suspended' ? 'purpose_suspended' : 'purpose_retired',
      resource: { type: 'purpose_definition', id }, detail: { purpose_sessions_ended: endedIds.length },
    });
    return { row: updated, ended: endedIds };
  });
  await dropCopies(deps, subject.actor.organisationId, ended);
  return row;
}

export async function listPurposeDefinitions(deps: AdminDeps, ctx: HandlerContext): Promise<PurposeDefinition[]> {
  const subject = await requireActor(deps, ctx);
  return tx(deps, subject, (db) => purposeDefinitionRepo.list(db));
}

// ----------------------------------------------------------------------------- eligibility

export async function grantPurposeEligibility(deps: AdminDeps, ctx: HandlerContext, input: { purposeDefinitionId: string; grantee: Grantee;
  expiresAt?: string | undefined }): Promise<PurposeEligibility> {
  const subject = await requireActor(deps, ctx);
  const granter = membershipOf(subject);
  await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  const g = input.grantee;
  const columns = {
    granteeMembershipId: g.kind === 'membership' ? g.id : null, granteeRoleId: g.kind === 'role' ? g.id : null,
    granteeScopeId: g.kind === 'scope' ? g.id : null, granteeServicePrincipalId: g.kind === 'service_principal' ? g.id : null,
  };
  return tx(deps, subject, async (db) => {
    const definition = await purposeDefinitionRepo.findById(db, input.purposeDefinitionId);
    if (!definition || definition.status === 'retired') throw new AppError('not_found', 'no such purpose definition', { code: 'purpose.not_found' });
    const live = (await purposeEligibilityRepo.list(db, definition.id)).find((e) => e.granteeMembershipId === columns.granteeMembershipId
      && e.granteeRoleId === columns.granteeRoleId && e.granteeScopeId === columns.granteeScopeId
      && e.granteeServicePrincipalId === columns.granteeServicePrincipalId);
    if (live) return live;
    const row = await purposeEligibilityRepo.insert(db, {
      id: uuidv7(), organisationId: subject.actor.organisationId, purposeDefinitionId: definition.id, ...columns, grantedBy: granter,
      expiresAt: input.expiresAt ?? null,
    });
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'purpose_eligibility_granted', subjectMembershipId: columns.granteeMembershipId,
      resource: { type: 'purpose_definition', id: definition.id }, detail: { grantee_kind: g.kind, grantee_id: g.id },
    });
    return row;
  });
}

/** clearance.grant (spec 58.5): who is eligible to declare a purpose, as whoever grants it sees it. */
export async function listPurposeEligibility(deps: AdminDeps, ctx: HandlerContext, purposeDefinitionId: string): Promise<PurposeEligibility[]> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  return tx(deps, subject, async (db) => {
    if (!(await purposeDefinitionRepo.findById(db, purposeDefinitionId))) throw new AppError('not_found', 'no such purpose definition', { code: 'purpose.not_found' });
    return purposeEligibilityRepo.list(db, purposeDefinitionId);
  });
}

export async function revokePurposeEligibility(deps: AdminDeps, ctx: HandlerContext, eligibilityId: string): Promise<PurposeEligibility> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  const { row, ended } = await tx(deps, subject, async (db) => {
    const before = await purposeEligibilityRepo.findById(db, eligibilityId);
    if (!before) throw new AppError('not_found', 'no such eligibility', { code: 'purpose_eligibility.not_found' });
    if (before.revokedAt !== null) return { row: before, ended: [] as string[] };
    const updated = (await purposeEligibilityRepo.update(db, eligibilityId, { revokedAt: new Date().toISOString() }))!;
    const endedIds = await purposeSessionRepo.endIneligible(db, subject.actor.organisationId, before.purposeDefinitionId);
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'purpose_eligibility_revoked', subjectMembershipId: before.granteeMembershipId,
      resource: { type: 'purpose_definition', id: before.purposeDefinitionId }, detail: { purpose_sessions_ended: endedIds.length },
    });
    return { row: updated, ended: endedIds };
  });
  await dropCopies(deps, subject.actor.organisationId, ended);
  return row;
}

// ----------------------------------------------------------------------------- purpose sessions

export async function declarePurpose(deps: AdminDeps, ctx: HandlerContext, input: { purposeDefinitionId: string;
  justification?: string | undefined; minutes?: number | undefined }): Promise<PurposeSession> {
  const subject = await requireActor(deps, ctx);
  const membershipId = membershipOf(subject);
  const { organisationId, sessionId } = subject.actor;
  // purpose.declare is "held by any eligible membership" (spec 58.10): eligibility is the
  // grant, checked below; no seeded role carries the permission.
  const session = await deps.sessions.readHash(sessionKeys, sessionKeys.key(organisationId, { sessionId: sessionId! }));
  if (!session) throw new AppError('unauthenticated', 'this session is not live', { code: 'policy.session_unknown' });
  const { row, markingId } = await tx(deps, subject, async (db) => {
    const definition = await purposeDefinitionRepo.findById(db, input.purposeDefinitionId);
    if (!definition || definition.status !== 'approved') {
      throw new AppError('forbidden', 'only an approved purpose is declared', { code: 'purpose.not_approved' });
    }
    if (!await purposeEligibilityRepo.isEligible(db, organisationId, definition.id, { membershipId, servicePrincipalId: null })) {
      throw new AppError('forbidden', 'you are not eligible to declare this purpose', { code: 'purpose.not_eligible' });
    }
    const justification = input.justification?.trim() ?? '';
    if (definition.requiresJustification && justification.length === 0) {
      throw new AppError('validation', 'this purpose needs a justification', { code: 'purpose.justification_required' });
    }
    const declaredAt = Date.now();
    const minutes = Math.min(input.minutes ?? definition.maxSessionMinutes, definition.maxSessionMinutes);
    const expiresAt = new Date(Math.min(declaredAt + minutes * 60_000, Date.parse(session.absoluteExpiresAt))).toISOString();
    const created = await purposeSessionRepo.insert(db, {
      id: uuidv7(), organisationId, membershipId, sessionId: sessionId!, purposeDefinitionId: definition.id,
      justification: justification.length === 0 ? null : justification, declaredAt: new Date(declaredAt).toISOString(), expiresAt,
      requiresApproval: definition.requiresApproval,
    });
    // The record a reviewer tests access against; the justification stays with the session row.
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'purpose_session_declared', resource: { type: 'purpose_session', id: created.id },
      detail: { purpose_definition_id: definition.id, minutes, justified: justification.length > 0, awaiting_approval: definition.requiresApproval },
    });
    return { row: created, markingId: definition.markingId };
  });
  if (!row.requiresApproval) await writeCopy(deps, row, markingId);
  return row;
}

/** The hot copy policy reads first: written once a session reaches its data. */
async function writeCopy(deps: AdminDeps, row: PurposeSession, markingId: string): Promise<void> {
  const ttl = Math.min(DAY_SECONDS, Math.floor((Date.parse(row.expiresAt) - Date.now()) / 1000));
  const organisationId = row.organisationId;
  const membershipId = row.membershipId!;
  if (ttl >= 1) {
    await deps.sessions.putHash(purposeSessionKeys, purposeSessionKeys.key(organisationId, { purposeSessionId: row.id }), {
      purposeDefinitionId: row.purposeDefinitionId, membershipId, sessionId: row.sessionId, markingId,
      startedAt: row.declaredAt, endsAt: row.expiresAt,
    }, { ttlSeconds: ttl }).catch(() => undefined);
  }
}

/** Approves a declaration its definition requires approved (D81): purpose.define, not the declarer, within its time. */
export async function approvePurposeSession(deps: AdminDeps, ctx: HandlerContext, purposeSessionId: string): Promise<PurposeSession> {
  const subject = await requireActor(deps, ctx);
  const approver = membershipOf(subject);
  await demand(deps, ctx, subject, 'purpose.define', { organisationWide: true });
  const { row, markingId } = await tx(deps, subject, async (db) => {
    const before = await purposeSessionRepo.findById(db, purposeSessionId);
    if (!before) throw new AppError('not_found', 'no such purpose session', { code: 'purpose_session.not_found' });
    if (before.membershipId === approver) throw new AppError('forbidden', 'you declared it; another person approves it', { code: 'purpose.self_approval' });
    if (!await purposeSessionRepo.approve(db, purposeSessionId, approver)) {
      throw new AppError('conflict', 'it needs no approval, is approved already, or has ended', { code: 'purpose_session.not_awaiting_approval' });
    }
    const definition = (await purposeDefinitionRepo.findById(db, before.purposeDefinitionId))!;
    await recordPolicyEvent(db, { ...event(ctx, subject), event: 'purpose_session_approved', resource: { type: 'purpose_session', id: purposeSessionId },
      detail: { purpose_definition_id: definition.id, use: definition.use } });
    return { row: (await purposeSessionRepo.findById(db, purposeSessionId))!, markingId: definition.markingId };
  });
  await writeCopy(deps, row, markingId);
  return row;
}

export async function endPurposeSession(deps: AdminDeps, ctx: HandlerContext, purposeSessionId: string): Promise<PurposeSession> {
  const subject = await requireActor(deps, ctx);
  const membershipId = membershipOf(subject);
  const row = await tx(deps, subject, async (db) => {
    const before = await purposeSessionRepo.findById(db, purposeSessionId);
    if (!before || before.membershipId !== membershipId) throw new AppError('not_found', 'no such purpose session', { code: 'purpose_session.not_found' });
    if (before.endedAt !== null) return before;
    const updated = (await purposeSessionRepo.update(db, purposeSessionId, { endedAt: new Date().toISOString(), endedReason: 'ended_by_user' }))!;
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'purpose_session_ended', resource: { type: 'purpose_session', id: purposeSessionId },
      detail: { reason: 'ended_by_user' },
    });
    return updated;
  });
  await dropCopies(deps, subject.actor.organisationId, [purposeSessionId]);
  return row;
}

export async function listPurposeSessions(deps: AdminDeps, ctx: HandlerContext): Promise<PurposeSession[]> {
  const subject = await requireActor(deps, ctx);
  const membershipId = membershipOf(subject);
  return tx(deps, subject, (db) => purposeSessionRepo.listOpen(db, { membershipId }));
}
