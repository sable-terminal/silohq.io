// What studio runs on, and what every part of it shares: the acting member, policy
// decisions, the ontology version an app binds, Action types, and audit events through the
// outbox.

import { getActionType } from '../../contracts/actions/actionType.contract.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { getActiveVersion, getManifest, getVersionManifest, listVersions, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { StudioEventName } from '../../contracts/studio/events.contract.ts';
import type { CallOutput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ActionTypeFact } from './validator.service.ts';

export interface StudioDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

export interface Member {
  organisationId: string;
  membershipId: string;
  request: RequestContext;
}

/** Apps are a person's to build, review and open (35.10: even the AI FDE's drafts are owned by a person). */
export function member(ctx: Context): Member {
  const { organisationId, membershipId } = ctx.request;
  if (membershipId === undefined) throw new AppError('forbidden', 'a person does this, never a service principal', { code: 'studio.member_required' });
  return { organisationId: organisationId!, membershipId, request: ctx.request };
}

export interface Decision {
  permission: string;
  scopeId?: string;
  resource?: { type: 'app' | 'object_type'; id: string };
}

export async function allowed(deps: StudioDeps, ctx: Context, decision: Decision): Promise<boolean> {
  const answer = await deps.services.call(authorise, { body: decision }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow';
}

export async function demand(deps: StudioDeps, ctx: Context, decision: Decision): Promise<void> {
  if (!await allowed(deps, ctx, decision)) {
    throw new AppError('forbidden', `you do not hold ${decision.permission} there`, { code: 'studio.not_permitted', details: { permission: decision.permission } });
  }
}

export type Access = CallOutput<typeof resolveAccess>;

export function access(deps: StudioDeps, ctx: Context, body: {
  objectTypes: string[]; properties: string[]; linkTypes: string[]; actionTypes: string[]; markings: string[];
}): Promise<Access> {
  return deps.services.call(resolveAccess, { body: { ...body, connections: [] } }, { request: ctx.request, correlationId: ctx.correlationId });
}

/** Main's head. */
export function mainManifest(deps: StudioDeps, ctx: Context): Promise<OntologyManifest> {
  return deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
}

/** The manifest of main at a sequence, or undefined when main has no such version (or it is too old to find). */
export async function manifestAt(deps: StudioDeps, ctx: Context, sequence: number, branchId?: string): Promise<OntologyManifest | undefined> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const head = await deps.services.call(getActiveVersion, { query: branchId === undefined ? {} : { branchId } }, options);
  if (head.sequence === sequence) return deps.services.call(getVersionManifest, { params: { versionId: head.id } }, options);
  const versions = await deps.services.call(listVersions, { query: { limit: 500 } }, options);
  const found = versions.versions.find((v) => v.sequence === sequence && v.branchId === head.branchId);
  return found === undefined ? undefined : deps.services.call(getVersionManifest, { params: { versionId: found.id } }, options);
}

/** The Action types an app names, as the actions service reports them; absent when unknown. */
export async function actionFacts(deps: StudioDeps, ctx: Context, ids: readonly string[]): Promise<Map<string, ActionTypeFact>> {
  const facts = new Map<string, ActionTypeFact>();
  for (const id of new Set(ids)) {
    try {
      const type = await deps.services.call(getActionType, { params: { actionTypeId: id } }, { request: ctx.request, correlationId: ctx.correlationId });
      facts.set(id, { id, status: type.status, objectTypeId: type.current?.objectTypeId ?? null });
    } catch (error) {
      if (!isAppError(error) || error.category !== 'not_found') throw error;
    }
  }
  return facts;
}

export const appNotFound = (): AppError => new AppError('not_found', 'no such app', { code: 'studio.app_not_found' });

export interface StudioEvent {
  event: StudioEventName;
  resource: { type: string; id: string } | null;
  subjectMembershipId?: string | null;
  scopeId?: string | null;
  detail?: Record<string, string | number | boolean | null | string[]>;
}

/** An audit event, in the transaction that made the change (spec 9.2). */
/** An event of studio acting on its own (an invalidation found on read), not of the person whose read found it. */
export async function recordServiceEvent(db: Queryable, organisationId: string, correlationId: string, e: StudioEvent): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: { kind: 'service', service: 'studio' }, subjectMembershipId: e.subjectMembershipId ?? null,
    scopeId: e.scopeId ?? null, resource: e.resource, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

export async function recordEvent(db: Queryable, who: Member, correlationId: string, e: StudioEvent): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: { kind: 'membership', membershipId: who.membershipId }, subjectMembershipId: e.subjectMembershipId ?? null,
    scopeId: e.scopeId ?? null, resource: e.resource, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, topic: auditEventMessage.topic, orderingKey: who.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
