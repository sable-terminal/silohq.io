// What the ontology service runs on, and the pieces every part of it shares: who is
// acting, the policy decision, audit events through the outbox, and main's head.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { OntologyEventName } from '../../contracts/ontology/events.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { OntologyBranch } from '../../models/ontology/ontologyBranch.model.ts';
import { ontologyBranchRepo } from '../../repos/ontology/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { requireOperatorSession } from '../admin-portal/sessionCheck.service.ts';
import { createMain, type Actor } from './store.service.ts';

export interface OntologyDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  /** The clock of the deprecation lifecycle (tests move it). */
  now?: (() => Date) | undefined;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

export interface Acting extends Actor {
  organisationId: string;
}

/** The membership or service principal acting. Every ontology request has one. */
export function acting(ctx: Context): Acting {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    // Silo staff read under a break-glass session (demandView checks it); they never change anything.
    if (ctx.caller === 'admin-portal' && ctx.request.operatorSessionId !== undefined) {
      return { organisationId: organisationId!, membershipId: undefined, servicePrincipalId: undefined };
    }
    throw new AppError('forbidden', 'the ontology is read and changed by a member or a service principal', { code: 'ontology.actor_required' });
  }
  return { organisationId: organisationId!, membershipId, servicePrincipalId };
}

/** A person: confirming, approving, merging and publishing are never a service principal's (spec 22.6, 25.4). */
export function person(ctx: Context, what: string): Acting & { membershipId: string } {
  const actor = acting(ctx);
  if (actor.membershipId === undefined) {
    throw new AppError('forbidden', `${what} is done by a person, never a service principal`, { code: 'ontology.person_required' });
  }
  return actor as Acting & { membershipId: string };
}

export async function allowed(deps: OntologyDeps, ctx: Context, permission: string): Promise<boolean> {
  const decision = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  return decision.decision === 'allow';
}

export async function demand(deps: OntologyDeps, ctx: Context, permission: string): Promise<void> {
  if (!await allowed(deps, ctx, permission)) {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'ontology.not_permitted', details: { permission } });
  }
}

/**
 * Reads through the gateway are a person's, and need ontology.view; services apply the
 * vocabulary themselves. Silo staff read through admin-portal under a running break-glass
 * session: the manifest is metadata (spec 13.3).
 */
export async function demandView(deps: OntologyDeps, ctx: Context): Promise<void> {
  if (ctx.caller === 'gateway') await demand(deps, ctx, 'ontology.view');
  if (ctx.caller === 'admin-portal') {
    await inTransaction(deps.databases.pool('control'), ctx.request, (db) => requireOperatorSession(db, ctx.request, 'metadata_read'), { readOnly: true });
  }
}

export interface OntologyEvent {
  event: OntologyEventName;
  resource: { type: string; id: string };
  detail?: Record<string, string | number | boolean | null | string[]>;
}

/** An audit event, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, actor: Acting, correlationId: string, e: OntologyEvent): Promise<void> {
  const who: AuditActor = actor.membershipId !== undefined ? { kind: 'membership', membershipId: actor.membershipId }
    : actor.servicePrincipalId !== undefined ? { kind: 'service_principal', servicePrincipalId: actor.servicePrincipalId }
      : { kind: 'service', service: 'ontology' };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: who, subjectMembershipId: null, scopeId: null, resource: e.resource, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: actor.organisationId, topic: auditEventMessage.topic, orderingKey: actor.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

/** Main, created with an empty first version the first time anyone touches the ontology. */
export async function mainBranch(deps: OntologyDeps, actor: Acting): Promise<OntologyBranch> {
  const pool = deps.databases.pool('control');
  const context = { organisationId: actor.organisationId };
  const found = await inTransaction(pool, context, (db) => ontologyBranchRepo.findMain(db), { readOnly: true });
  if (found) return found;
  // Silo staff under break-glass read; they never create the organisation's ontology.
  if (actor.membershipId === undefined && actor.servicePrincipalId === undefined) {
    throw new AppError('not_found', 'this organisation has no ontology yet', { code: 'ontology.none_yet' });
  }
  try {
    return await inTransaction(pool, context, (db) => createMain(db, actor.organisationId, actor));
  } catch (error) {
    // Another request created it first.
    if (isAppError(error) && error.category === 'conflict') {
      return (await inTransaction(pool, context, (db) => ontologyBranchRepo.findMain(db), { readOnly: true }))!;
    }
    throw error;
  }
}
