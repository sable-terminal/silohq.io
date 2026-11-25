// What the policy service's administration and governance share: the actor of a request,
// decisions made in-process (policy decides for itself, never over HTTP), refusals that
// are audited, and audit events written to the outbox in the transaction of the change.

import type { CELL_KINDS } from '../../config/cell.config.ts';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { PolicyEventName } from '../../contracts/policy/events.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import { fdePrincipalRepo } from '../../repos/fde/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ActorRef, Policy, ResourceRef, Subject } from './policy.service.ts';

export interface AdminDeps {
  databases: Databases;
  /** The cell's kind: change windows apply to dedicated, sovereign and on-premises cells (spec 11.5). Absent: a shared cell. */
  cellKind?: (typeof CELL_KINDS)[number] | undefined;
  sessions: RedisStore;
  logger: Logger;
  policy: Policy;
  catalogue: ReadonlyMap<string, 'standard' | 'authorising' | 'silo_staff'>;
  /**
   * Hands a suspended or removed member's saved views to the admin above them (workspace's
   * transferViews, spec 37.10). Absent where no workspace runs.
   */
  /** Hands a removed member's connections to their owning scope's admin or a super admin (connect-registry, spec 55.7). */
  transferConnections?: ((request: HandlerContext['request'], correlationId: string, membershipId: string) => Promise<void>) | undefined;
  /** Hands a suspended or removed member's apps to the admin above them (studio's transferApps, spec 37.7). Absent where no studio runs. */
  transferApps?: ((request: HandlerContext['request'], correlationId: string, membershipId: string, reason: 'member_removed' | 'member_suspended')
    => Promise<void>) | undefined;
  transferViews?: ((request: HandlerContext['request'], correlationId: string, membershipId: string, reason: 'member_removed' | 'member_suspended')
    => Promise<void>) | undefined;
}

/** The actor of a request, from the context the caller sent. */
export function actorOf(ctx: HandlerContext): ActorRef {
  const { organisationId, membershipId, servicePrincipalId, sessionId } = ctx.request;
  if (organisationId === undefined) throw new AppError('validation', 'a request runs in an organisation', { code: 'context.organisation_missing' });
  if (membershipId !== undefined) return { organisationId, membershipId, sessionId };
  if (servicePrincipalId !== undefined) return { organisationId, servicePrincipalId, sessionId };
  throw new AppError('forbidden', 'a request acts as a membership or a service principal', { code: 'policy.no_actor' });
}

/** The audit actor for an actor. */
export const auditActorOf = (actor: ActorRef): AuditActor => (actor.membershipId !== undefined
  ? { kind: 'membership', membershipId: actor.membershipId }
  : { kind: 'service_principal', servicePrincipalId: actor.servicePrincipalId });

/** The transaction context for an actor: its organisation and who it acts as, for row-level security. */
export const contextOf = (actor: ActorRef): RequestContext => ({
  organisationId: actor.organisationId,
  ...(actor.membershipId !== undefined ? { membershipId: actor.membershipId } : {}),
  ...(actor.servicePrincipalId !== undefined ? { servicePrincipalId: actor.servicePrincipalId } : {}),
});

export interface PolicyEventInput {
  organisationId: string;
  correlationId: string;
  event: PolicyEventName | 'connection_granted' | 'connection_grant_revoked' | 'seat_reclaimed' | 'fde_ceiling_refusal';
  actor: AuditActor;
  subjectMembershipId?: string | null | undefined;
  scopeId?: string | null | undefined;
  resource?: { type: string; id: string } | null | undefined;
  detail?: Record<string, string | number | boolean | null | string[]> | undefined;
}

/** Writes the event to the outbox, in the transaction that made the change (spec 9.2). */
export async function recordPolicyEvent(db: Queryable, input: PolicyEventInput): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor: input.actor, subjectMembershipId: input.subjectMembershipId ?? null, scopeId: input.scopeId ?? null,
    resource: input.resource ?? null, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: input.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}

/** Refusals that are authorisation decisions, and so audited; the rest are authentication. */
export const AUDITED_DENIALS: ReadonlySet<string> = new Set([
  'not_granted', 'membership_inactive', 'marking_unsatisfied', 'principal_inactive', 'principal_never_authorises',
]);

/** Records authorisation_denied in its own transaction: the refusal stands even if this fails. */
export async function recordDenial(deps: Pick<AdminDeps, 'databases' | 'logger'>, actor: ActorRef, correlationId: string,
  detail: { permission: string; reason: string }, resource?: ResourceRef, scopeId?: string): Promise<void> {
  await inTransaction(deps.databases.pool('control'), contextOf(actor), (db) => recordPolicyEvent(db, {
    organisationId: actor.organisationId, correlationId, event: 'authorisation_denied', actor: auditActorOf(actor),
    scopeId: scopeId ?? null, resource: resource ?? null, detail,
  })).catch((error: unknown) => deps.logger.failure('authorisation_denied not recorded', error, { event: 'policy.denial_not_recorded' }));
}

/** fde_ceiling_refusal (spec 52.1, 52.8), when the refused principal is an AI FDE principal. Best effort, as recordDenial. */
export async function recordCeilingRefusal(deps: Pick<AdminDeps, 'databases' | 'logger'>, actor: ActorRef, correlationId: string,
  detail: { permission: string; reason: string }): Promise<void> {
  await inTransaction(deps.databases.pool('control'), contextOf(actor), async (db) => {
    const fde = await fdePrincipalRepo.findByServicePrincipalId(db, { organisationId: actor.organisationId, servicePrincipalId: actor.servicePrincipalId! });
    if (fde === undefined) return;
    await recordPolicyEvent(db, {
      organisationId: actor.organisationId, correlationId, event: 'fde_ceiling_refusal', actor: auditActorOf(actor), scopeId: null,
      resource: { type: 'fde_engagement', id: fde.engagementId }, detail: { ...detail, role: fde.role, fde_principal_id: fde.id },
    });
  }).catch((error: unknown) => deps.logger.failure('fde_ceiling_refusal not recorded', error, { event: 'policy.ceiling_refusal_not_recorded' }));
}

export interface Demand {
  scopeId?: string | undefined;
  resource?: ResourceRef | undefined;
  organisationWide?: boolean | undefined;
}

/**
 * A live actor for an administrative request: its session live and MFA satisfied, the
 * membership active (or the principal live). Refused otherwise.
 */
export async function requireActor(deps: AdminDeps, ctx: HandlerContext): Promise<Subject> {
  const actor = actorOf(ctx);
  const resolved = await deps.policy.resolve(actor);
  if (resolved.reason !== 'allowed') {
    throw new AppError(resolved.reason === 'session_unknown' ? 'unauthenticated' : 'forbidden', 'this request is not authorised', {
      code: `policy.${resolved.reason}`,
    });
  }
  return resolved.subject;
}

/** Whether the actor may use a permission there; never throws for a refusal. */
export async function may(deps: AdminDeps, subject: Subject, permission: string, where: Demand = {}): Promise<boolean> {
  return (await deps.policy.decideFor(subject, { permission, ...where })) === 'allowed';
}

/** The permission there, or a refusal that is audited (spec 57.11: authorisation_denied). */
export async function demand(deps: AdminDeps, ctx: HandlerContext, subject: Subject, permission: string, where: Demand = {}): Promise<void> {
  const reason = await deps.policy.decideFor(subject, { permission, ...where });
  if (reason === 'allowed') return;
  if (AUDITED_DENIALS.has(reason)) {
    await recordDenial(deps, subject.actor, ctx.correlationId, { permission, reason }, where.resource, where.scopeId);
  }
  throw new AppError('forbidden', 'you may not do that', { code: 'policy.not_permitted', details: { permission, reason } });
}

/** A membership actor only: refused for a service principal. */
export function membershipOf(subject: Subject): string {
  if (subject.actor.membershipId === undefined) {
    throw new AppError('forbidden', 'a person does this, not a service principal', { code: 'policy.person_required' });
  }
  return subject.actor.membershipId;
}

/** A database refusal (a delegation trigger) as an AppError with the reason the check gave, or the error itself. */
export function isInsufficientPrivilege(error: unknown): boolean {
  return error instanceof AppError && error.details['sqlstate'] === '42501';
}
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof AppError && error.details['sqlstate'] === '23505';
}
export function isCheckViolation(error: unknown): boolean {
  return error instanceof AppError && (error.details['sqlstate'] === '23514' || error.details['sqlstate'] === 'P0001');
}
