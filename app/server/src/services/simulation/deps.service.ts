// What the simulation service runs on, and what every part of it shares: the actor, policy
// decisions, the reader's view of the ontology, and audit events through the outbox.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { getManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { SimulationEventName } from '../../contracts/simulation/events.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface SimulationDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'idempotencyKey'>;

export interface Actor {
  organisationId: string;
  membershipId: string | undefined;
  servicePrincipalId: string | undefined;
  request: RequestContext;
}

export function actor(ctx: Context): Actor {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'simulation acts for a member or a service principal', { code: 'simulation.actor_required' });
  }
  return { organisationId: organisationId!, membershipId, servicePrincipalId, request: ctx.request };
}

/** Confirming an edge, running and owning a scenario are a person's (spec 39.3: the AI FDE never confirms). */
export function member(ctx: Context): Actor & { membershipId: string } {
  const who = actor(ctx);
  if (who.membershipId === undefined) {
    throw new AppError('forbidden', 'only a person does this', { code: 'simulation.member_required' });
  }
  return who as Actor & { membershipId: string };
}

export async function demand(deps: SimulationDeps, ctx: Context, permission: string): Promise<void> {
  const answer = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (answer.decision !== 'allow') {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'simulation.not_permitted', details: { permission } });
  }
}

export function readManifest(deps: SimulationDeps, ctx: Context): Promise<OntologyManifest> {
  return deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
}

/** Which object and link types the reader is cleared for (spec 39.10: marking checks apply). */
export async function visibility(deps: SimulationDeps, ctx: Context, ask: { objectTypes?: string[]; linkTypes?: string[] }) {
  const answer = await deps.services.call(resolveAccess, {
    body: { objectTypes: [...new Set(ask.objectTypes ?? [])], linkTypes: [...new Set(ask.linkTypes ?? [])] },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const allowed = answer.decision === 'allow';
  return {
    typeVisible: (id: string) => allowed && answer.objectTypes.some((t) => t.id === id && t.visible),
    linkVisible: (id: string) => allowed && answer.linkTypes.some((l) => l.id === id && l.visible),
  };
}

export interface SimulationEvent {
  event: SimulationEventName;
  resource: { type: string; id: string } | null;
  detail?: Record<string, string | number | boolean | null>;
}

export async function recordEvent(db: Queryable, who: Actor, correlationId: string, e: SimulationEvent): Promise<void> {
  const auditActor = who.membershipId !== undefined ? { kind: 'membership' as const, membershipId: who.membershipId }
    : { kind: 'service_principal' as const, servicePrincipalId: who.servicePrincipalId! };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: auditActor, subjectMembershipId: null, scopeId: null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, topic: auditEventMessage.topic, orderingKey: who.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

/** A duration in seconds. */
export const SECONDS: Readonly<Record<'minutes' | 'hours' | 'days' | 'weeks', number>> = { minutes: 60, hours: 3_600, days: 86_400, weeks: 604_800 };
export const secondsOf = (d: { value: number; unit: keyof typeof SECONDS } | null | undefined): number => (d ? d.value * SECONDS[d.unit] : 0);
