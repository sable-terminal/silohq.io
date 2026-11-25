// What the recognition service runs on, and what every part of it shares: the actor, the
// policy decisions, the reader's view of the ontology, and audit events through the outbox.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { getManifest, type ObjectTypeView, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { RecognitionEventName } from '../../contracts/recognition/events.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface RecognitionDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export interface Actor {
  organisationId: string;
  /** Absent for a scheduled run by a service principal. */
  membershipId: string | undefined;
  servicePrincipalId: string | undefined;
  request: RequestContext;
}

export function actor(ctx: Context): Actor {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'recognition runs for a member or a service principal', { code: 'recognition.actor_required' });
  }
  return { organisationId: organisationId!, membershipId, servicePrincipalId, request: ctx.request };
}

/** Lenses and dispositions are a person's. */
export function member(ctx: Context): Actor & { membershipId: string } {
  const who = actor(ctx);
  if (who.membershipId === undefined) {
    throw new AppError('forbidden', 'a Lens or a disposition belongs to a member', { code: 'recognition.member_required' });
  }
  return who as Actor & { membershipId: string };
}

export async function demand(deps: RecognitionDeps, ctx: Context, permission: string,
  resource?: { type: 'object_type'; id: string }): Promise<void> {
  const answer = await deps.services.call(authorise, { body: { permission, ...(resource ? { resource } : {}) } },
    { request: ctx.request, correlationId: ctx.correlationId });
  if (answer.decision !== 'allow') {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'recognition.not_permitted', details: { permission } });
  }
}

/** Main's head as the reader sees the ontology; the reader's access is applied separately. */
export function readManifest(deps: RecognitionDeps, ctx: Context): Promise<OntologyManifest> {
  return deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
}

export function typeOf(manifest: OntologyManifest, objectTypeId: string): ObjectTypeView {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (type === undefined) throw new AppError('not_found', 'no such object type', { code: 'recognition.object_type_not_found' });
  return type;
}

export type Access = Awaited<ReturnType<typeof access>>;

/** One policy decision for what a batch of findings or a run needs (spec 57.6 steps 3 to 5). */
export async function access(deps: RecognitionDeps, ctx: Context,
  ask: { objectTypes?: string[]; properties?: string[]; connections?: string[]; markings?: string[] },
  /** For a member who is not present (a Lens's coverage at share, decision 2026-11-14). */
  asMembershipId?: string) {
  const unique = (ids: string[] | undefined) => [...new Set(ids ?? [])];
  const answer = await deps.services.call(resolveAccess, {
    body: {
      objectTypes: unique(ask.objectTypes), properties: unique(ask.properties), connections: unique(ask.connections), markings: unique(ask.markings),
      ...(asMembershipId === undefined ? {} : { asMembershipId }),
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return {
    allowed: answer.decision === 'allow',
    typeVisible: (id: string) => answer.objectTypes.some((t) => t.id === id && t.visible),
    /** Visible with no field policy: what a detector may examine and a finding may name. */
    propertyClear: (id: string) => answer.properties.some((p) => p.id === id && p.visible && p.effect === 'allow'),
    connectionReadable: (id: string) => answer.connections.some((c) => c.id === id && c.access !== 'none'),
    markingSatisfied: (id: string) => answer.markings.some((m) => m.id === id && m.satisfied),
  };
}

export interface RecognitionEvent {
  event: RecognitionEventName;
  resource: { type: string; id: string } | null;
  detail?: Record<string, string | number | boolean | null>;
}

/** An audit event, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, who: Actor, correlationId: string, e: RecognitionEvent): Promise<void> {
  const auditActor = who.membershipId !== undefined ? { kind: 'membership' as const, membershipId: who.membershipId }
    : who.servicePrincipalId !== undefined ? { kind: 'service_principal' as const, servicePrincipalId: who.servicePrincipalId }
      : { kind: 'service' as const, service: 'recognition' as const };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: auditActor, subjectMembershipId: null, scopeId: null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, topic: auditEventMessage.topic, orderingKey: who.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
