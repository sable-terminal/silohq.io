// Markings, clearances and field policies (spec 57.4, 57.7, 58.2 to 58.4, 58.9, 58.10).
//
// - Markings are the organisation's own (Silo ships none) and created organisation-wide
//   (marking.manage). Retired, never deleted.
// - A direct marking narrows access at once. A super admin applies any marking; an admin
//   applies one only to a connection owned within their subtree and only a marking they
//   satisfy themselves (spec 58.10). Removing one is a declassification Action (58.9),
//   decided by declassificationDecision (declassification.service.ts).
// - Clearances are granted and revoked organisation-wide only (clearance.grant: super
//   admin, never delegable), for classification and compartment markings; a purpose is
//   satisfied by a purpose session instead (purposes.service.ts).
// - Field policies deny, mask or redact a source field or a property for an audience,
//   resolved before any plan exists (57.4). Managed with marking.manage (the spec names no
//   permission of their own), at their audience's scope or organisation-wide.

import { declassifierMembershipRepo } from '../../repos/gov/index.repo.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { MARKABLE } from '../../contracts/policy/governance.contract.ts';
import { clearanceRepo, markingRepo, resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { connectionGrantRepo, fieldPolicyRepo, membershipRepo, objectTypeMarkingRepo, servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import type { Clearance } from '../../models/gov/clearance.model.ts';
import type { Marking } from '../../models/gov/marking.model.ts';
import type { FieldPolicy } from '../../models/iam/fieldPolicy.model.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  actorOf, auditActorOf, contextOf, demand, isUniqueViolation, may, membershipOf, recordPolicyEvent, requireActor, type AdminDeps,
} from './deps.service.ts';
import { markingsByResource, type Subject } from './policy.service.ts';

const tx = <T>(deps: AdminDeps, subject: Subject, work: (db: Queryable) => Promise<T>): Promise<T> =>
  inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work);

const event = (ctx: HandlerContext, subject: Subject) => ({
  organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
});

// ----------------------------------------------------------------------------- markings

export async function createMarking(deps: AdminDeps, ctx: HandlerContext, input: { name: string; kind: Marking['kind'];
  rank?: number | undefined; description: string }): Promise<Marking> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  await demand(deps, ctx, subject, 'marking.manage', { organisationWide: true });
  try {
    return await tx(deps, subject, async (db) => {
      const row = await markingRepo.insert(db, {
        id: uuidv7(), organisationId: subject.actor.organisationId, name: input.name, kind: input.kind, rank: input.rank ?? null,
        description: input.description, createdBy: actor,
      });
      await recordPolicyEvent(db, { ...event(ctx, subject), event: 'marking_created', resource: { type: 'marking', id: row.id }, detail: { kind: row.kind } });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'a marking with that name exists', { code: 'marking.name_taken' });
    throw error;
  }
}

/** Every marking for those who manage them; for anyone else, only the markings they satisfy (spec 58.3: shown to holders). */
export async function listMarkings(deps: AdminDeps, ctx: HandlerContext, includeRetired: boolean): Promise<Marking[]> {
  const subject = await requireActor(deps, ctx);
  const markings = await tx(deps, subject, (db) => markingRepo.list(db, includeRetired));
  if (await may(deps, subject, 'marking.manage')) return markings;
  return markings.filter((m) => subject.satisfied.has(m.id));
}

export async function retireMarking(deps: AdminDeps, ctx: HandlerContext, markingId: string): Promise<Marking> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'marking.manage', { organisationWide: true });
  return tx(deps, subject, async (db) => {
    const marking = await markingRepo.findById(db, markingId);
    if (!marking) throw new AppError('not_found', 'no such marking', { code: 'marking.not_found' });
    if (marking.retiredAt !== null) return marking;
    const row = (await markingRepo.update(db, markingId, { retiredAt: new Date().toISOString(), version: marking.version + 1 }))!;
    await recordPolicyEvent(db, { ...event(ctx, subject), event: 'marking_retired', resource: { type: 'marking', id: markingId } });
    return row;
  });
}

type Markable = (typeof MARKABLE)[number];

export async function applyMarking(deps: AdminDeps, ctx: HandlerContext, input: { markingId: string; resource: { type: Markable; id: string } })
  : Promise<{ markingId: string; resource: { type: Markable; id: string }; applied: boolean }> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  const { type, id } = input.resource;
  const marking = await tx(deps, subject, (db) => markingRepo.findById(db, input.markingId));
  if (!marking || marking.retiredAt !== null) throw new AppError('not_found', 'no such marking', { code: 'marking.not_found' });
  if (!await may(deps, subject, 'marking.manage', { organisationWide: true })) {
    // An admin: a connection owned within their subtree, and a marking they hold (spec 58.10).
    const facts = type === 'connection' ? await tx(deps, subject, (db) => connectionGrantRepo.connectionFacts(db, id)) : undefined;
    if (facts === undefined) await demand(deps, ctx, subject, 'marking.manage', { organisationWide: true });
    else await demand(deps, ctx, subject, 'marking.manage', { scopeId: facts.owningScopeId });
    if (marking.kind === 'purpose' || !subject.satisfied.has(marking.id)) {
      throw new AppError('forbidden', 'an admin applies only a marking they hold', { code: 'marking.not_held' });
    }
  }
  return tx(deps, subject, async (db) => {
    const existing = (await markingsByResource(db, type, [id])).get(id) ?? [];
    if (existing.includes(input.markingId)) return { markingId: input.markingId, resource: input.resource, applied: false };
    if (type === 'object_type') {
      await objectTypeMarkingRepo.insert(db, { organisationId: subject.actor.organisationId, objectTypeId: id, markingId: input.markingId, appliedBy: actor });
    } else {
      await resourceMarkingRepo.insert(db, {
        id: uuidv7(), organisationId: subject.actor.organisationId, markingId: input.markingId, appliedBy: actor, [`${camel(type)}Id`]: id,
      });
    }
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: type === 'object_type' ? 'object_type_marking_changed' : 'resource_marking_changed',
      resource: { type, id }, detail: { marking_id: input.markingId, change: 'applied' },
    });
    return { markingId: input.markingId, resource: input.resource, applied: true };
  });
}

const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The object view's banner (34.2): the markings on a type and on the properties shown, their own and their fields'. */
export async function markingBanner(deps: AdminDeps, ctx: HandlerContext, body: { objectTypeId: string; propertyIds: string[] })
  : Promise<{ markings: { id: string; name: string; kind: Marking['kind'] }[] }> {
  const subject = await requireActor(deps, ctx);
  return tx(deps, subject, async (db) => {
    const ids = new Set<string>();
    for (const list of (await markingsByResource(db, 'object_type', [body.objectTypeId])).values()) for (const id of list) ids.add(id);
    for (const list of (await markingsByResource(db, 'property', body.propertyIds)).values()) for (const id of list) ids.add(id);
    for (const m of await resourceMarkingRepo.mappedFieldMarkings(db, body.propertyIds)) ids.add(m.markingId);
    const order = { classification: 0, compartment: 1, purpose: 2 } as const;
    const markings = (await markingRepo.list(db, false)).filter((m) => ids.has(m.id))
      .sort((a, b) => order[a.kind] - order[b.kind] || (b.rank ?? 0) - (a.rank ?? 0) || a.name.localeCompare(b.name));
    return { markings: markings.map((m) => ({ id: m.id, name: m.name, kind: m.kind })) };
  });
}

export async function listResourceMarkings(deps: AdminDeps, ctx: HandlerContext, resource: { type: Markable; id: string }): Promise<string[]> {
  const subject = await requireActor(deps, ctx);
  return (await tx(deps, subject, (db) => markingsByResource(db, resource.type, [resource.id]))).get(resource.id) ?? [];
}

// ----------------------------------------------------------------------------- clearances

export async function grantClearance(deps: AdminDeps, ctx: HandlerContext, input: { markingId: string;
  holder: { kind: 'membership' | 'service_principal'; id: string }; expiresAt?: string | undefined }): Promise<Clearance> {
  const subject = await requireActor(deps, ctx);
  const granter = membershipOf(subject);
  await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  return tx(deps, subject, async (db) => {
    const marking = await markingRepo.findById(db, input.markingId);
    if (!marking || marking.retiredAt !== null) throw new AppError('not_found', 'no such marking', { code: 'marking.not_found' });
    if (marking.kind === 'purpose') {
      throw new AppError('validation', 'a purpose is not cleared: grant eligibility to declare it (spec 58.5)', { code: 'clearance.purpose_marking' });
    }
    const membership = input.holder.kind === 'membership';
    if (membership ? (await membershipRepo.findById(db, input.holder.id))?.status !== 'active' : !await servicePrincipalRepo.findById(db, input.holder.id)) {
      throw new AppError('not_found', 'no such holder', { code: 'clearance.holder_not_found' });
    }
    const live = (await clearanceRepo.list(db, membership ? { membershipId: input.holder.id, markingId: input.markingId } : { markingId: input.markingId }))
      .find((c) => (membership ? c.membershipId : c.servicePrincipalId) === input.holder.id);
    if (live) return live;
    const row = await clearanceRepo.insert(db, {
      id: uuidv7(), organisationId: subject.actor.organisationId, membershipId: membership ? input.holder.id : null,
      servicePrincipalId: membership ? null : input.holder.id, markingId: marking.id, markingKind: marking.kind, grantedBy: granter,
      expiresAt: input.expiresAt ?? null,
    });
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'clearance_granted', subjectMembershipId: row.membershipId, resource: { type: 'clearance', id: row.id },
      detail: { marking_id: marking.id, holder_kind: input.holder.kind, holder_id: input.holder.id },
    });
    return row;
  });
}

export async function revokeClearance(deps: AdminDeps, ctx: HandlerContext, clearanceId: string): Promise<Clearance> {
  const subject = await requireActor(deps, ctx);
  const revoker = membershipOf(subject);
  await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  return tx(deps, subject, async (db) => {
    const before = await clearanceRepo.findById(db, clearanceId);
    if (!before) throw new AppError('not_found', 'no such clearance', { code: 'clearance.not_found' });
    if (before.revokedAt !== null) return before;
    const row = (await clearanceRepo.update(db, clearanceId, { revokedAt: new Date().toISOString(), revokedBy: revoker }))!;
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'clearance_revoked', subjectMembershipId: before.membershipId, resource: { type: 'clearance', id: clearanceId },
      detail: { marking_id: before.markingId },
    });
    return row;
  });
}

export async function listClearances(deps: AdminDeps, ctx: HandlerContext, filter: { membershipId?: string | undefined;
  markingId?: string | undefined }): Promise<Clearance[]> {
  const subject = await requireActor(deps, ctx);
  if (filter.membershipId === undefined || filter.membershipId !== subject.actor.membershipId) {
    await demand(deps, ctx, subject, 'clearance.grant', { organisationWide: true });
  }
  return tx(deps, subject, (db) => clearanceRepo.list(db, filter));
}

// ----------------------------------------------------------------------------- field policies

export async function createFieldPolicy(deps: AdminDeps, ctx: HandlerContext, input: {
  target: { connectionId: string; fieldPath: string } | { propertyId: string };
  effect: FieldPolicy['effect'];
  appliesTo: { roleId?: string | undefined; markingId?: string | undefined; scopeId?: string | undefined; includeDescendants: boolean };
}): Promise<FieldPolicy> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  await demand(deps, ctx, subject, 'marking.manage', input.appliesTo.scopeId === undefined ? { organisationWide: true } : { scopeId: input.appliesTo.scopeId });
  return tx(deps, subject, async (db) => {
    const row = await fieldPolicyRepo.insert(db, {
      id: uuidv7(), organisationId: subject.actor.organisationId,
      connectionId: 'connectionId' in input.target ? input.target.connectionId : null,
      fieldPath: 'connectionId' in input.target ? input.target.fieldPath : null,
      propertyId: 'propertyId' in input.target ? input.target.propertyId : null,
      effect: input.effect, appliesToRoleId: input.appliesTo.roleId ?? null, appliesToMarkingId: input.appliesTo.markingId ?? null,
      appliesToScopeId: input.appliesTo.scopeId ?? null, includeDescendants: input.appliesTo.includeDescendants, createdBy: actor,
    });
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'field_policy_changed', scopeId: row.appliesToScopeId, resource: { type: 'field_policy', id: row.id },
      detail: { change: 'created', effect: row.effect },
    });
    return row;
  });
}

export async function retireFieldPolicy(deps: AdminDeps, ctx: HandlerContext, fieldPolicyId: string): Promise<FieldPolicy> {
  const subject = await requireActor(deps, ctx);
  const policy = await tx(deps, subject, (db) => fieldPolicyRepo.findById(db, fieldPolicyId));
  if (!policy) throw new AppError('not_found', 'no such field policy', { code: 'field_policy.not_found' });
  await demand(deps, ctx, subject, 'marking.manage', policy.appliesToScopeId === null ? { organisationWide: true } : { scopeId: policy.appliesToScopeId });
  if (policy.retiredAt !== null) return policy;
  return tx(deps, subject, async (db) => {
    const row = (await fieldPolicyRepo.update(db, fieldPolicyId, { retiredAt: new Date().toISOString(), version: policy.version + 1 }))!;
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'field_policy_changed', scopeId: row.appliesToScopeId, resource: { type: 'field_policy', id: row.id },
      detail: { change: 'retired', effect: row.effect },
    });
    return row;
  });
}

export async function listFieldPolicies(deps: AdminDeps, ctx: HandlerContext, filter: { connectionId?: string | undefined;
  propertyId?: string | undefined }): Promise<FieldPolicy[]> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'marking.manage');
  return tx(deps, subject, (db) => fieldPolicyRepo.list(db, filter));
}

// ----------------------------------------------------------------------------- declassification

export type DeclassificationReason = 'allowed' | 'not_granted' | 'marking_unsatisfied' | 'self_approval' | 'principal_never_authorises'
  | 'membership_inactive' | 'session_unknown' | 'mfa_required';

/**
 * Spec 58.9: requesting needs marking.declassify (super admin only: the spec's "a
 * membership named for that marking" has no data model yet) and satisfying the marking;
 * approving needs satisfying it and not being the requester. No service principal does
 * either.
 */
/** "A membership named for that marking" (58.10; D81): an approved, live declassifier grant. */
async function namedDeclassifier(deps: AdminDeps, organisationId: string, markingId: string, membershipId: string): Promise<boolean> {
  return inTransaction(deps.databases.pool('control'), { organisationId, membershipId }, (db) => declassifierMembershipRepo.liveFor(db, markingId, membershipId),
    { readOnly: true });
}

export async function declassificationDecision(deps: AdminDeps, ctx: HandlerContext, input: { markingId: string; step: 'request' | 'approve';
  requestedBy?: string | undefined }): Promise<DeclassificationReason> {
  const actor = actorOf(ctx);
  if (actor.servicePrincipalId !== undefined) return 'principal_never_authorises';
  const resolved = await deps.policy.resolve(actor);
  if (resolved.reason !== 'allowed') {
    return resolved.reason === 'mfa_required' || resolved.reason === 'session_unknown' || resolved.reason === 'membership_inactive'
      ? resolved.reason : 'not_granted';
  }
  const subject = resolved.subject;
  if (input.step === 'request' && !await may(deps, subject, 'marking.declassify', { organisationWide: true })
    && !await namedDeclassifier(deps, actor.organisationId, input.markingId, actor.membershipId!)) return 'not_granted';
  if (input.step === 'approve' && input.requestedBy === actor.membershipId) return 'self_approval';
  return subject.satisfied.has(input.markingId) ? 'allowed' : 'marking_unsatisfied';
}
