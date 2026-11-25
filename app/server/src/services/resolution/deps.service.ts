// What the resolution service runs on, and what every part of it shares: who is acting, the
// policy decisions, audit events through the outbox, the ontology manifest by version, the
// type's key plan, and keyed hashes from the credential service.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { hashForEntityGraph, MAX_ENTITY_HASH_VALUES, type EntityHashPurpose } from '../../contracts/credential/entityHash.contract.ts';
import { getActiveVersion, getVersionManifest, type ObjectTypeView, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { ResolutionEventName } from '../../contracts/resolution/events.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { resolutionProposalRepo } from '../../repos/ontology/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { keyPlan, type KeyPlan } from './identity.service.ts';

export interface ResolutionDeps {
  databases: Databases;
  services: ServiceClient;
  /** redis-data: run status and the per-type run lock. */
  data: RedisStore;
  logger: Logger;
  /** The executor's bound on one read (spec 27.7): a contributing object larger than this cannot be read whole. */
  maxRowsPerRead: number;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

export interface Acting {
  organisationId: string;
  membershipId: string | undefined;
  servicePrincipalId: string | undefined;
}

export function acting(ctx: Context): Acting {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'resolution is changed by a member or a service principal', { code: 'resolution.actor_required' });
  }
  return { organisationId: organisationId!, membershipId, servicePrincipalId };
}

/** A person: confirming, rejecting and declaring are never a service principal's (spec 23.2, 23.4). */
export function person(ctx: Context, what: string): Acting & { membershipId: string } {
  const actor = acting(ctx);
  if (actor.membershipId === undefined) {
    throw new AppError('forbidden', `${what} is done by a person, never a service principal`, { code: 'resolution.person_required' });
  }
  return actor as Acting & { membershipId: string };
}

const call = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });

export async function demand(deps: ResolutionDeps, ctx: Context, permission: string, objectTypeId?: string): Promise<void> {
  const decision = await deps.services.call(authorise, {
    body: { permission, ...(objectTypeId === undefined ? {} : { resource: { type: 'object_type' as const, id: objectTypeId } }) },
  }, call(ctx));
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'resolution.not_permitted', details: { permission } });
  }
}

/** Read access to every connection named: a person decides only over data they may read (spec 23.2, 23.4). */
export async function demandReadAll(deps: ResolutionDeps, ctx: Context, connectionIds: readonly string[]): Promise<void> {
  const ids = [...new Set(connectionIds)];
  if (ids.length === 0) return;
  const access = await deps.services.call(resolveAccess, { body: { connections: ids } }, call(ctx));
  const short = access.decision !== 'allow' ? ids.length : access.connections.filter((c) => c.access === 'none').length;
  if (short > 0) {
    throw new AppError('forbidden', 'you need read access to every connection involved', {
      code: 'resolution.connection_access_required', details: { connections: short },
    });
  }
}

export interface ResolutionEvent {
  event: ResolutionEventName;
  resource: { type: string; id: string };
  detail?: Record<string, string | number | boolean | null | string[]>;
}

/** An audit event, in the transaction that made the change (spec 9.2). */
export async function recordEvent(db: Queryable, actor: Acting, correlationId: string, e: ResolutionEvent): Promise<void> {
  const who: AuditActor = actor.membershipId !== undefined ? { kind: 'membership', membershipId: actor.membershipId }
    : actor.servicePrincipalId !== undefined ? { kind: 'service_principal', servicePrincipalId: actor.servicePrincipalId }
      : { kind: 'service', service: 'resolution' };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: who, subjectMembershipId: null, scopeId: null, resource: e.resource, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: actor.organisationId, topic: auditEventMessage.topic, orderingKey: actor.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

// ----------------------------------------------------------------------------- the ontology

const manifests = new Map<string, OntologyManifest>();

/** A version's manifest: immutable, so cached by version id. */
export async function manifestAt(deps: ResolutionDeps, ctx: Context, versionId: string): Promise<OntologyManifest> {
  const cached = manifests.get(`${ctx.request.organisationId}:${versionId}`);
  if (cached) return cached;
  const manifest = await deps.services.call(getVersionManifest, { params: { versionId } }, call(ctx));
  if (manifests.size > 100) manifests.clear();
  manifests.set(`${ctx.request.organisationId}:${versionId}`, manifest);
  return manifest;
}

/** Main's head manifest. */
export async function activeManifest(deps: ResolutionDeps, ctx: Context): Promise<OntologyManifest> {
  const head = await deps.services.call(getActiveVersion, { query: {} }, call(ctx));
  return manifestAt(deps, ctx, head.id);
}

export function typeIn(manifest: OntologyManifest, objectTypeId: string): ObjectTypeView {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId);
  if (!type) throw new AppError('not_found', 'no such object type in that ontology version', { code: 'resolution.type_not_found' });
  return type;
}

/** The type's key: its declared match keys, then its confirmed rules, oldest first. */
export async function planFor(deps: ResolutionDeps, organisationId: string, type: ObjectTypeView, extraRules: readonly string[] = [])
  : Promise<{ plan: KeyPlan; rules: string[] }> {
  const confirmed = await inTransaction(deps.databases.pool('control'), { organisationId },
    (db) => resolutionProposalRepo.confirmedRules(db, type.id), { readOnly: true });
  const rules = [...confirmed.map((p) => (p.proposal as { cel: string }).cel), ...extraRules];
  return { plan: keyPlan(type.resolutionClass === 'resolvable' ? type.matchKeys : [], rules), rules };
}

// ----------------------------------------------------------------------------- hashing

/** Keyed hashes under the organisation key, batched to the credential service's bound. */
export async function hashAll(deps: ResolutionDeps, ctx: Context, purpose: EntityHashPurpose, values: readonly string[])
  : Promise<{ keyVersionId: string; hashes: string[] }> {
  if (values.length === 0) return { keyVersionId: '', hashes: [] };
  const hashes: string[] = [];
  let keyVersionId = '';
  for (let i = 0; i < values.length; i += MAX_ENTITY_HASH_VALUES) {
    const out = await deps.services.call(hashForEntityGraph, { body: { purpose, values: values.slice(i, i + MAX_ENTITY_HASH_VALUES) } }, call(ctx));
    hashes.push(...out.hashes);
    keyVersionId = out.keyVersionId;
  }
  return { keyVersionId, hashes };
}
