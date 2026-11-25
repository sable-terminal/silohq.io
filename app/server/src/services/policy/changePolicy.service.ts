// When a dedicated, sovereign or on-premises cell may change (spec 11.5;
// contracts/policy/changePolicy.contract.ts). The windows, freezes and change authority are
// the customer's; Fleet holds the cell to them once its agent has carried them to
// fleet-control (D120). A shared commercial cell takes releases in Silo's waves: there the
// policy reads as not applying and every setter refuses.
//
// - The change authority must be an active member when named; an approval counts only from
//   whoever is named at the time it is made, and Fleet checks again when it applies it.
// - change_freeze_set is raised when a freeze is set, ended early, or an exception approved in
//   it, with what was done.

import type { ChangePolicyView } from '../../contracts/policy/changePolicy.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { JsonValue } from '../../models/table.model.ts';
import { changeExceptionRepo, changeFreezeRepo, changePolicyRepo } from '../../repos/gov/index.repo.ts';
import { membershipRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { auditActorOf, contextOf, demand, membershipOf, recordPolicyEvent, requireActor, type AdminDeps } from './deps.service.ts';

const MANAGE = 'org.change_window.manage';
const DEFAULT_TIME_ZONE = 'Europe/London';
const MAX_FREEZE_MS = 366 * 24 * 3_600_000;

const applies = (deps: AdminDeps): boolean => deps.cellKind !== undefined && deps.cellKind !== 'commercial';
const notApplicable = (): AppError => new AppError('conflict',
  'this is a shared cell: it takes releases in Silo\'s waves; change windows and freezes are for dedicated, sovereign and on-premises cells',
  { code: 'policy.change_windows_not_applicable' });
const iso = (value: string): string => new Date(Date.parse(value)).toISOString();

async function viewOf(deps: AdminDeps, db: Queryable, organisationId: string): Promise<ChangePolicyView> {
  const policy = await changePolicyRepo.findByOrganisationId(db, organisationId);
  const freezes = await changeFreezeRepo.current(db, organisationId, new Date().toISOString());
  const exceptions = await changeExceptionRepo.forFreezes(db, organisationId, freezes.map((f) => f.id));
  return {
    applies: applies(deps),
    timeZone: policy?.timeZone ?? DEFAULT_TIME_ZONE,
    windows: (policy?.windows ?? []) as unknown as ChangePolicyView['windows'],
    changeAuthorityMembershipId: policy?.changeAuthorityMembershipId ?? null,
    updatedAt: policy ? iso(policy.updatedAt) : null,
    freezes: freezes.map((f) => ({
      id: f.id, startsAt: iso(f.startsAt), endsAt: iso(f.endsAt), reason: f.reason, setBy: f.setBy, setAt: iso(f.setAt),
      endedAt: f.endedAt === null ? null : iso(f.endedAt), endedBy: f.endedBy,
    })),
    exceptions: exceptions.map((e) => ({
      id: e.id, freezeId: e.freezeId, releaseId: e.releaseId, statement: e.statement, approvedBy: e.approvedBy, approvedAt: iso(e.approvedAt),
    })),
  };
}

export async function getChangePolicy(deps: AdminDeps, ctx: HandlerContext): Promise<ChangePolicyView> {
  const subject = await requireActor(deps, ctx);
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), (db) => viewOf(deps, db, subject.actor.organisationId), { readOnly: true });
}

export async function setChangePolicy(deps: AdminDeps, ctx: HandlerContext,
  input: { timeZone: string; windows: ChangePolicyView['windows']; changeAuthorityMembershipId: string | null }): Promise<ChangePolicyView> {
  if (!applies(deps)) throw notApplicable();
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, MANAGE, { organisationWide: true });
  const organisationId = subject.actor.organisationId;
  const by = membershipOf(subject);
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), async (db) => {
    if (input.changeAuthorityMembershipId !== null) {
      const authority = await membershipRepo.findById(db, input.changeAuthorityMembershipId);
      if (authority === undefined || authority.status !== 'active') {
        throw new AppError('validation', 'the change authority is an active member of the organisation', { code: 'policy.change_authority_unknown' });
      }
    }
    const fields = { timeZone: input.timeZone, windows: input.windows as unknown as JsonValue, changeAuthorityMembershipId: input.changeAuthorityMembershipId, updatedBy: by };
    if (await changePolicyRepo.findByOrganisationId(db, organisationId) === undefined) await changePolicyRepo.insert(db, { organisationId, ...fields });
    else await changePolicyRepo.update(db, organisationId, fields);
    return viewOf(deps, db, organisationId);
  });
}

export async function setChangeFreeze(deps: AdminDeps, ctx: HandlerContext, freezeId: string,
  input: { startsAt: string; endsAt: string; reason: string }): Promise<ChangePolicyView> {
  if (!applies(deps)) throw notApplicable();
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, MANAGE, { organisationWide: true });
  const organisationId = subject.actor.organisationId;
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), async (db) => {
    const existing = await changeFreezeRepo.findById(db, freezeId);
    if (existing !== undefined) {
      const same = Date.parse(existing.startsAt) === Date.parse(input.startsAt) && Date.parse(existing.endsAt) === Date.parse(input.endsAt)
        && existing.reason === input.reason;
      if (!same) throw new AppError('conflict', 'a different freeze was set under that id', { code: 'policy.freeze_exists' });
      return viewOf(deps, db, organisationId);
    }
    if (Date.parse(input.endsAt) <= Date.now()) throw new AppError('validation', 'a freeze ends in the future', { code: 'policy.freeze_over' });
    if (Date.parse(input.endsAt) - Date.parse(input.startsAt) > MAX_FREEZE_MS) {
      throw new AppError('validation', 'a freeze lasts at most a year; set another when it ends', { code: 'policy.freeze_too_long' });
    }
    await changeFreezeRepo.insert(db, { id: freezeId, organisationId, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason, setBy: membershipOf(subject) });
    await recordPolicyEvent(db, {
      organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'change_freeze_set',
      resource: { type: 'change_freeze', id: freezeId }, detail: { action: 'set', starts_at: iso(input.startsAt), ends_at: iso(input.endsAt), reason: input.reason },
    });
    return viewOf(deps, db, organisationId);
  });
}

export async function endChangeFreeze(deps: AdminDeps, ctx: HandlerContext, freezeId: string): Promise<ChangePolicyView> {
  if (!applies(deps)) throw notApplicable();
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, MANAGE, { organisationWide: true });
  const organisationId = subject.actor.organisationId;
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), async (db) => {
    const freeze = await changeFreezeRepo.findById(db, freezeId);
    if (freeze === undefined) throw new AppError('not_found', 'no such freeze', { code: 'policy.freeze_unknown' });
    if (freeze.endedAt === null && Date.parse(freeze.endsAt) > Date.now()) {
      const endedAt = new Date().toISOString();
      await changeFreezeRepo.update(db, freezeId, { endedAt, endedBy: membershipOf(subject) });
      await recordPolicyEvent(db, {
        organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'change_freeze_set',
        resource: { type: 'change_freeze', id: freezeId }, detail: { action: 'ended', ended_at: endedAt },
      });
    }
    return viewOf(deps, db, organisationId);
  });
}

export async function approveFreezeException(deps: AdminDeps, ctx: HandlerContext,
  input: { freezeId: string; releaseId: string; statement: string }): Promise<ChangePolicyView> {
  if (!applies(deps)) throw notApplicable();
  const subject = await requireActor(deps, ctx);
  const by = membershipOf(subject);
  const organisationId = subject.actor.organisationId;
  return inTransaction(deps.databases.pool('control'), contextOf(subject.actor), async (db) => {
    const policy = await changePolicyRepo.findByOrganisationId(db, organisationId);
    if (policy?.changeAuthorityMembershipId !== by) {
      throw new AppError('forbidden', 'only the organisation\'s named change authority approves a change during a freeze', { code: 'policy.not_change_authority' });
    }
    const freeze = await changeFreezeRepo.findById(db, input.freezeId);
    if (freeze === undefined) throw new AppError('not_found', 'no such freeze', { code: 'policy.freeze_unknown' });
    if (freeze.endedAt !== null || Date.parse(freeze.endsAt) <= Date.now()) {
      throw new AppError('conflict', 'that freeze is over: nothing to approve', { code: 'policy.freeze_over' });
    }
    if (await changeExceptionRepo.findByFreezeIdAndReleaseId(db, { organisationId, freezeId: input.freezeId, releaseId: input.releaseId }) === undefined) {
      const id = uuidv7();
      await changeExceptionRepo.insert(db, { id, organisationId, freezeId: input.freezeId, releaseId: input.releaseId, statement: input.statement, approvedBy: by });
      await recordPolicyEvent(db, {
        organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'change_freeze_set',
        resource: { type: 'change_freeze', id: input.freezeId }, detail: { action: 'exception_approved', release_id: input.releaseId },
      });
    }
    return viewOf(deps, db, organisationId);
  });
}

/** For the cell's Fleet agent: every organisation's policy in fleet-control's shape. */
export async function listChangePoliciesForFleet(deps: AdminDeps): Promise<{ policies: unknown[] }> {
  const rows = await inTransaction(deps.databases.pool('control'), {}, (db) => changePolicyRepo.forFleet(db, new Date().toISOString()), { readOnly: true });
  return { policies: rows.map((r) => r.policy) };
}
