// What the metering services need, and the rules they share: who may read what (the policy
// service decides), the actor an audit event names, and the event writer.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { billingEventSchema, type BillingActor, type BillingEvent } from '../../contracts/billing/billingEvent.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface MeteringSettings {
  /** Spec 73.2's "short window" for a rephrase that charges once. Not set by the spec; this build uses 10 minutes. */
  rephraseWindowSeconds: number;
  /** Spec 73.7's reduced re-run rate, in simulations. An open decision; this build uses half a simulation. */
  simulationRerunWeight: string;
}

export const DEFAULT_SETTINGS: MeteringSettings = { rephraseWindowSeconds: 600, simulationRerunWeight: '0.5' };

export interface MeteringDeps {
  databases: Databases;
  /** redis-data: the rephrase window and refusal notices. */
  data: RedisStore;
  services: ServiceClient;
  logger: Logger;
  settings: MeteringSettings;
}

/** A person's request must be allowed the permission by the policy service. */
export async function requirePermission(deps: Pick<MeteringDeps, 'services'>, ctx: HandlerContext, permission: string): Promise<void> {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'this is for a member of the organisation', { code: 'metering.not_permitted', details: { permission } });
  }
  const decision = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', `you may not do this: it needs ${permission}`, {
      code: 'metering.not_permitted', details: { permission, reason: decision.reason },
    });
  }
}

/** The actor of the request, as audit.audit_events records it. */
export function actorOf(request: RequestContext): BillingActor {
  if (request.membershipId !== undefined) return { kind: 'membership', membershipId: request.membershipId };
  if (request.servicePrincipalId !== undefined) return { kind: 'service_principal', servicePrincipalId: request.servicePrincipalId };
  return { kind: 'service', service: 'metering' };
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
