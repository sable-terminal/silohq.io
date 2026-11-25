// What the workspace service runs on, and what every part of it shares: the acting
// member, the policy decision, and audit events through the outbox.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { WorkspaceEventName, WORKSPACE_HIGH_VOLUME_EVENTS } from '../../contracts/workspace/events.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { QueryEngine } from './queryEngine.service.ts';

export interface WorkspaceDeps {
  databases: Databases;
  services: ServiceClient;
  /** redis-data: a view's last result reference. */
  data: RedisStore;
  logger: Logger;
  engine: QueryEngine;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

export interface Member {
  organisationId: string;
  membershipId: string;
  request: RequestContext;
}

/** Saved views, threads and preferences are a person's: every request names its member. */
export function member(ctx: Context): Member {
  const { organisationId, membershipId } = ctx.request;
  if (membershipId === undefined) {
    throw new AppError('forbidden', 'the workspace belongs to a member, never a service principal', { code: 'workspace.member_required' });
  }
  return { organisationId: organisationId!, membershipId, request: ctx.request };
}

export interface Decision {
  permission: string;
  scopeId?: string;
  resource?: { type: 'view' | 'app'; id: string };
  organisationWide?: true;
}

export async function allowed(deps: WorkspaceDeps, ctx: Context, decision: Decision): Promise<boolean> {
  const answer = await deps.services.call(authorise, { body: decision }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow';
}

export async function demand(deps: WorkspaceDeps, ctx: Context, decision: Decision): Promise<void> {
  if (!await allowed(deps, ctx, decision)) {
    throw new AppError('forbidden', `you do not hold ${decision.permission} there`, {
      code: 'workspace.not_permitted', details: { permission: decision.permission },
    });
  }
}

/** Not there, or not the caller's to see: the same answer, so existence is never disclosed. */
export const viewNotFound = (): AppError => new AppError('not_found', 'no such view', { code: 'workspace.view_not_found' });

export interface WorkspaceEvent {
  event: WorkspaceEventName | (typeof WORKSPACE_HIGH_VOLUME_EVENTS)[number];
  resource: { type: string; id: string } | null;
  subjectMembershipId?: string | null;
  scopeId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

/** An audit event, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, who: Member | { organisationId: string; service: 'workspace' } | { organisationId: string; servicePrincipalId: string },
  correlationId: string, e: WorkspaceEvent): Promise<void> {
  const actor = 'membershipId' in who ? { kind: 'membership' as const, membershipId: who.membershipId }
    // A pipeline's schedule acts as its own principal (D241).
    : 'servicePrincipalId' in who ? { kind: 'service_principal' as const, servicePrincipalId: who.servicePrincipalId }
      : { kind: 'service' as const, service: who.service };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: e.subjectMembershipId ?? null, scopeId: e.scopeId ?? null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, topic: auditEventMessage.topic, orderingKey: who.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
