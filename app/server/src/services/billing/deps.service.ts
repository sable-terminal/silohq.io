// What the billing services need, and the rules they share: who may act (the policy
// service decides for a person; a staff path needs a live operator session), and the
// audit event writer.

import type { Config } from '../../config/index.config.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { billingEventSchema, type BillingActor, type BillingEvent } from '../../contracts/billing/billingEvent.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { PaymentProvider } from '../../infra/payments/payments.infra.ts';
import type { Databases, Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { operatorAccessSessionRepo, outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface BillingDeps {
  config: Config;
  databases: Databases;
  services: ServiceClient;
  payments: PaymentProvider;
  logger: Logger;
}

/** A person's request must be allowed the permission by the policy service. */
export async function requirePermission(deps: Pick<BillingDeps, 'services'>, ctx: HandlerContext, permission: string): Promise<void> {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'this is for a member of the organisation', { code: 'billing.not_permitted', details: { permission } });
  }
  const decision = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', `you may not do this: it needs ${permission}`, {
      code: 'billing.not_permitted', details: { permission, reason: decision.reason },
    });
  }
}

/**
 * A staff path names a staff identity (spec 75.3): the operator of a live, acting operator
 * session on this organisation. Call inside the transaction that makes the change.
 */
export async function requireOperator(db: Queryable, ctx: HandlerContext): Promise<BillingActor & { kind: 'operator' }> {
  const sessionId = ctx.request.operatorSessionId;
  const session = sessionId === undefined ? undefined : await operatorAccessSessionRepo.findById(db, sessionId);
  if (session === undefined || session.organisationId !== ctx.request.organisationId || session.status !== 'active'
    || session.accessLevel !== 'tenant_act' || (session.expiresAt !== null && Date.parse(session.expiresAt) <= Date.now())) {
    throw new AppError('forbidden', 'a staff path needs a live operator session that may act for this organisation', {
      code: 'billing.operator_session_required',
    });
  }
  return { kind: 'operator', operatorId: session.operatorId, operatorAccessSessionId: session.id };
}

export interface EventInput {
  organisationId: string;
  correlationId: string;
  event: BillingEvent['event'];
  actor: BillingActor;
  subjectMembershipId?: string | null | undefined;
  resource?: BillingEvent['resource'] | undefined;
  detail?: BillingEvent['detail'] | undefined;
}

export const SYSTEM: BillingActor = { kind: 'service', service: 'billing' };

/** Writes the event to the outbox, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, input: EventInput): Promise<void> {
  const payload = auditEventMessage.schema.parse(billingEventSchema.parse({
    event: input.event, actor: input.actor, subjectMembershipId: input.subjectMembershipId ?? null, scopeId: null,
    resource: input.resource ?? null, purposeSessionId: null,
    operatorAccessSessionId: input.actor.kind === 'operator' ? input.actor.operatorAccessSessionId : null, ipHash: null,
    detail: input.detail ?? {},
  }));
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}
