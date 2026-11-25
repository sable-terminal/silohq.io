// Connect audit events go to the outbox in the transaction that made the change, so an event
// exists exactly when its change committed (spec 9.2). Shared by the connect services.
//
// The event travels as the audit service's audit_event: the acting membership or service
// principal is the actor, or else the connect service that made the change on its own (a
// token refresh, an expiry); the connector, manifest, connection, credential or OAuth client
// is the resource.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { connectEventSchema, type ConnectEvent } from '../../contracts/connect/connectEvent.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type ConnectService = 'connect-registry' | 'connect-runtime' | 'credential' | 'oauth' | 'conformance' | 'catalogue';

export interface ConnectEventInput {
  organisationId: string;
  correlationId: string;
  event: ConnectEvent['event'];
  membershipId?: string | null | undefined;
  servicePrincipalId?: string | null | undefined;
  /** The service acting on its own when no membership or principal acted. */
  service?: ConnectService | undefined;
  resourceType: ConnectEvent['resourceType'];
  resourceId: string;
  detail?: ConnectEvent['detail'];
}

/** Call inside a transaction with the organisation's context. */
export async function recordConnectEvent(db: Queryable, input: ConnectEventInput): Promise<void> {
  const event = connectEventSchema.parse({
    event: input.event, membershipId: input.membershipId ?? null, servicePrincipalId: input.servicePrincipalId ?? null,
    resourceType: input.resourceType, resourceId: input.resourceId, detail: input.detail ?? {},
  });
  const actor: AuditActor = event.membershipId !== null ? { kind: 'membership', membershipId: event.membershipId }
    : event.servicePrincipalId !== null ? { kind: 'service_principal', servicePrincipalId: event.servicePrincipalId }
      : { kind: 'service', service: input.service ?? 'connect-registry' };
  const payload = auditEventMessage.schema.parse({
    event: event.event, actor, subjectMembershipId: null, scopeId: null,
    resource: { type: event.resourceType, id: event.resourceId }, purposeSessionId: null, operatorAccessSessionId: null,
    ipHash: null, detail: event.detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}
