// Query-path audit events through the outbox (spec 9.2): written in their own small
// transaction, since a query changes nothing else. The actor is the membership or service
// principal the request runs as; the resource is the compiled plan where there is one, or
// what the event is about (the object type a question's vocabulary left out).

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { CompileEventName, QueryEventName } from '../../contracts/executor/events.contract.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type EventDetail = Record<string, string | number | boolean | null>;

export async function recordQueryEvent(databases: Databases, request: RequestContext, correlationId: string, event: QueryEventName,
  detail: EventDetail, planId?: string): Promise<void> {
  await recordQueryEvents(databases, request, correlationId, [{ event, detail, resource: planId === undefined ? null : { type: 'compiled_plan', id: planId } }]);
}

/**
 * Several query events in one small transaction, each about its own resource. Compile also
 * raises action_intent_bound here (42.12; catalogued with the Action events) when it binds an
 * intent to a confirmed Action type, since binding is compile's.
 */
export async function recordQueryEvents(databases: Databases, request: RequestContext, correlationId: string,
  events: readonly { event: QueryEventName | 'action_intent_bound'; detail: EventDetail; resource: { type: string; id: string } | null }[]): Promise<void> {
  if (events.length === 0) return;
  const organisationId = request.organisationId!;
  const actor: AuditActor = request.membershipId !== undefined ? { kind: 'membership', membershipId: request.membershipId }
    : request.servicePrincipalId !== undefined ? { kind: 'service_principal', servicePrincipalId: request.servicePrincipalId }
      : { kind: 'service', service: 'executor' };
  const payloads = events.map((e) => auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: null, scopeId: null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
    detail: Object.fromEntries(Object.entries(e.detail).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v])),
  }));
  await inTransaction(databases.pool('control'), request, async (db) => {
    for (const payload of payloads) {
      await outboxRepo.insert(db, {
        id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId,
        event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
      });
    }
  });
}

/** A compile event in the caller's transaction, beside the change it records (calendar_changed). */
export async function recordCompileEvent(db: Queryable, request: RequestContext, correlationId: string, event: CompileEventName, detail: EventDetail): Promise<void> {
  const organisationId = request.organisationId!;
  const payload = auditEventMessage.schema.parse({
    event, actor: { kind: 'membership', membershipId: request.membershipId! }, subjectMembershipId: null, scopeId: null,
    resource: { type: 'organisation', id: organisationId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
