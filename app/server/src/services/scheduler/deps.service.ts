// What the scheduler runs on, and what every part of it shares: the acting member, the
// policy decision, and audit events through the outbox.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { AutomationEventName } from '../../contracts/scheduler/events.contract.ts';
import type { SchedulerConfig } from '../../config/scheduler.config.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface SchedulerDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  config: SchedulerConfig;
  /** The clock: injected so tests can move it. */
  now: () => number;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export interface Member {
  organisationId: string;
  membershipId: string;
  request: RequestContext;
}

/** A Cron is a person's: every request to manage one names its member. */
export function member(ctx: Context): Member {
  const { organisationId, membershipId } = ctx.request;
  if (membershipId === undefined) {
    throw new AppError('forbidden', 'a Cron is managed by a member, never a service principal', { code: 'scheduler.member_required' });
  }
  return { organisationId: organisationId!, membershipId, request: ctx.request };
}

export interface Decision {
  permission: string;
  scopeId?: string;
}

export async function allowed(deps: SchedulerDeps, ctx: Context, decision: Decision): Promise<boolean> {
  const answer = await deps.services.call(authorise, { body: decision }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow';
}

export async function demand(deps: SchedulerDeps, ctx: Context, decision: Decision): Promise<void> {
  if (!await allowed(deps, ctx, decision)) {
    throw new AppError('forbidden', `you do not hold ${decision.permission}`, {
      code: 'scheduler.not_permitted', details: { permission: decision.permission },
    });
  }
}

/** Not there, or not the caller's to see: one answer, so existence is never disclosed. */
export const cronNotFound = (): AppError => new AppError('not_found', 'no such Cron', { code: 'scheduler.cron_not_found' });

export interface SchedulerEvent {
  event: AutomationEventName | 'service_principal_created' | 'service_principal_revoked';
  actor: AuditActor;
  resource: { type: string; id: string } | null;
  subjectMembershipId?: string | null;
  scopeId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export const memberActor = (membershipId: string): AuditActor => ({ kind: 'membership', membershipId });
export const cronActor = (servicePrincipalId: string): AuditActor => ({ kind: 'service_principal', servicePrincipalId });
export const schedulerActor: AuditActor = { kind: 'service', service: 'scheduler' };

/** An audit event, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, organisationId: string, correlationId: string, e: SchedulerEvent): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: e.actor, subjectMembershipId: e.subjectMembershipId ?? null, scopeId: e.scopeId ?? null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
