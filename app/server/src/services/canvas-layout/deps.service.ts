// What canvas-layout runs on, and what every part of it shares: the acting member or
// principal, policy decisions, main's ontology manifest, and audit events through the
// outbox.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import type { CloneEventName, CloneHighVolumeEventName } from '../../contracts/canvas-layout/events.contract.ts';
import { getManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { CallOutput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface CanvasDeps {
  databases: Databases;
  services: ServiceClient;
  /** redis-state: precomputed positions, under TTL, never on disk. */
  state: RedisStore;
  logger: Logger;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

export interface Actor {
  organisationId: string;
  request: RequestContext;
  membershipId: string | undefined;
  servicePrincipalId: string | undefined;
}

export function actor(ctx: Context): Actor {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'a member or a service principal acts here', { code: 'clone.actor_required' });
  }
  return { organisationId: organisationId!, request: ctx.request, membershipId, servicePrincipalId };
}

/** Canvas views, preferences and confirmations are a person's: the request must name a member. */
export function member(ctx: Context): Actor & { membershipId: string } {
  const who = actor(ctx);
  if (who.membershipId === undefined) {
    throw new AppError('forbidden', 'a person does this, never a service principal', { code: 'clone.member_required' });
  }
  return who as Actor & { membershipId: string };
}

export interface Decision {
  permission: string;
  scopeId?: string;
  resource?: { type: 'view' | 'object_type' | 'connection' | 'app'; id: string };
  organisationWide?: true;
}

export async function allowed(deps: CanvasDeps, ctx: Context, decision: Decision): Promise<boolean> {
  const answer = await deps.services.call(authorise, { body: decision }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow';
}

export async function demand(deps: CanvasDeps, ctx: Context, decision: Decision): Promise<void> {
  if (!await allowed(deps, ctx, decision)) {
    throw new AppError('forbidden', `you do not hold ${decision.permission} there`, {
      code: 'clone.not_permitted', details: { permission: decision.permission },
    });
  }
}

export type Access = CallOutput<typeof resolveAccess>;

export function access(deps: CanvasDeps, ctx: Context, body: { objectTypes?: string[]; properties?: string[]; linkTypes?: string[]; connections?: string[] })
  : Promise<Access> {
  return deps.services.call(resolveAccess, {
    body: {
      objectTypes: body.objectTypes ?? [], properties: body.properties ?? [], linkTypes: body.linkTypes ?? [], connections: body.connections ?? [],
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
}

/** Main's head: what configuration is checked against. */
export function mainManifest(deps: CanvasDeps, ctx: Context): Promise<OntologyManifest> {
  return deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
}

/** Not there, or not the caller's to see: the same answer, so existence is never disclosed. */
export const notFound = (what: string, code: string): AppError => new AppError('not_found', `no such ${what}`, { code });

export interface CloneEvent {
  event: CloneEventName | CloneHighVolumeEventName;
  resource: { type: string; id: string } | null;
  subjectMembershipId?: string | null;
  scopeId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

/** An audit event, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, who: Actor, correlationId: string, e: CloneEvent): Promise<void> {
  // A person, a service principal, or neither: the service acting on its own (a purge replayed after a restore, D251).
  const by = who.membershipId !== undefined ? { kind: 'membership' as const, membershipId: who.membershipId }
    : who.servicePrincipalId !== undefined ? { kind: 'service_principal' as const, servicePrincipalId: who.servicePrincipalId }
      : { kind: 'service' as const, service: 'canvas-layout' as const };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: by, subjectMembershipId: e.subjectMembershipId ?? null, scopeId: e.scopeId ?? null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, topic: auditEventMessage.topic, orderingKey: who.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
