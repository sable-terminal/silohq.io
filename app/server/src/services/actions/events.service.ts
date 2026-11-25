// Write-back's audit events and control messages, written to the outbox in the transaction
// that made the change (spec 9.2), so an event exists exactly when its change committed.
// Shared by actions, approvals and revert. References and counts only, never a value.

import { actionExecutedMessage, type ActionEventPayload } from '../../contracts/actions/actionEvent.contract.ts';
import { mutationStageMessage, type ActionEventName, type MutationStage } from '../../contracts/actions/events.contract.ts';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type WriteBackService = 'actions' | 'approvals' | 'revert' | 'conformance' | 'notify';

export type EventDetail = Record<string, string | number | boolean | null | string[]>;

export interface ActionEventInput {
  organisationId: string;
  correlationId: string;
  event: ActionEventName;
  /** The request's actor; a service acting on its own when neither is set. */
  request?: RequestContext | undefined;
  service: WriteBackService;
  resource: {
    type: 'action_type' | 'mutation' | 'approval_chain' | 'approval_policy' | 'receipt' | 'revert' | 'connection' | 'action_event_subscription' | 'organisation'
      | 'allowlist_entry';
    id: string;
  };
  scopeId?: string | null | undefined;
  subjectMembershipId?: string | null | undefined;
  detail?: EventDetail | undefined;
}

export function actorOf(request: RequestContext | undefined, service: WriteBackService): AuditActor {
  if (request?.membershipId !== undefined) return { kind: 'membership', membershipId: request.membershipId };
  if (request?.servicePrincipalId !== undefined) return { kind: 'service_principal', servicePrincipalId: request.servicePrincipalId };
  return { kind: 'service', service };
}

/** Call inside a transaction with the organisation's context. */
export async function recordActionEvent(db: Queryable, input: ActionEventInput): Promise<void> {
  // Identifier lists ride as arrays of UUIDs; other strings are references or closed-set names.
  const detail: Record<string, string | number | boolean | null | string[]> = {};
  for (const [key, value] of Object.entries(input.detail ?? {})) {
    detail[key] = Array.isArray(value) ? value.slice(0, 100) : value;
  }
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor: actorOf(input.request, input.service), subjectMembershipId: input.subjectMembershipId ?? null,
    scopeId: input.scopeId ?? null, resource: input.resource, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}

/** The stage a mutation reached, ordered by the mutation (spec 9.2 control.action). */
export async function recordMutationStage(db: Queryable, input: {
  organisationId: string; correlationId: string; mutationId: string; stage: MutationStage; receiptId?: string | null; rowCount: number;
}): Promise<void> {
  const payload = mutationStageMessage.schema.parse({
    mutationId: input.mutationId, stage: input.stage, receiptId: input.receiptId ?? null, rowCount: input.rowCount,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: mutationStageMessage.topic, orderingKey: input.mutationId,
    event: mutationStageMessage.name, schemaVersion: mutationStageMessage.version, payload, correlationId: input.correlationId,
  });
}

/** The outbound Action event (spec 48.3), ordered by the mutation, written with the receipt. */
export async function recordActionExecuted(db: Queryable, input: { organisationId: string; correlationId: string; payload: ActionEventPayload }): Promise<void> {
  const payload = actionExecutedMessage.schema.parse(input.payload);
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: actionExecutedMessage.topic, orderingKey: payload.mutationId,
    event: actionExecutedMessage.name, schemaVersion: actionExecutedMessage.version, payload, correlationId: input.correlationId,
  });
}
