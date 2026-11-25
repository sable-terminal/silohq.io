// What the files service runs on, and what every part of it shares: who is acting (a member,
// or a Cron's principal acting for its owner), the policy decisions, and audit events
// through the outbox.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { FileEventName } from '../../contracts/files/events.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { FilesConfig } from '../../config/files.config.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface FilesDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  store: ObjectStore;
  config: FilesConfig;
  now: () => number;
  /** Whether the cell has a tiles bucket for the basemap. */
  tilesConfigured?: boolean;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export interface Actor {
  organisationId: string;
  request: RequestContext;
  /** The membership the file is made by, or acted on for: a Cron's principal acts for its owner. */
  membershipId: string;
  audit: AuditActor;
  /** Set when a service principal acts. */
  servicePrincipalId: string | undefined;
}

/** A member, or (making an export only) a service principal acting for its owner. */
export async function actorOf(deps: FilesDeps, ctx: Context): Promise<Actor> {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId !== undefined) {
    return { organisationId: organisationId!, request: ctx.request, membershipId, audit: { kind: 'membership', membershipId }, servicePrincipalId: undefined };
  }
  if (servicePrincipalId !== undefined) {
    const principal = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => servicePrincipalRepo.findById(db, servicePrincipalId), { readOnly: true });
    if (!principal || principal.revokedAt !== null) throw new AppError('forbidden', 'the principal is not active', { code: 'files.principal_inactive' });
    return {
      organisationId: organisationId!, request: ctx.request, membershipId: principal.ownerMembershipId,
      audit: { kind: 'service_principal', servicePrincipalId }, servicePrincipalId,
    };
  }
  throw new AppError('forbidden', 'a file is made and opened by a member', { code: 'files.member_required' });
}

/** A member's own request: everything but making an export. */
export async function memberOf(deps: FilesDeps, ctx: Context): Promise<Actor> {
  const actor = await actorOf(deps, ctx);
  if (actor.servicePrincipalId !== undefined) throw new AppError('forbidden', 'files are opened and managed by members', { code: 'files.member_required' });
  return actor;
}

export async function allowed(deps: FilesDeps, ctx: Context, permission: string, organisationWide = false): Promise<boolean> {
  const answer = await deps.services.call(authorise, {
    body: { permission, ...(organisationWide ? { organisationWide: true as const } : {}) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow';
}

export async function demand(deps: FilesDeps, ctx: Context, permission: string, organisationWide = false): Promise<void> {
  if (!await allowed(deps, ctx, permission, organisationWide)) {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'files.not_permitted', details: { permission } });
  }
}

/** Whether the caller satisfies every one of these markings now (clearances, or a purpose session of this request). */
export async function satisfiesAll(deps: FilesDeps, ctx: Context, markingIds: readonly string[]): Promise<boolean> {
  if (markingIds.length === 0) return true;
  const answer = await deps.services.call(resolveAccess, { body: { markings: [...markingIds] } }, { request: ctx.request, correlationId: ctx.correlationId });
  return answer.decision === 'allow' && markingIds.every((id) => answer.markings.find((m) => m.id === id)?.satisfied === true);
}

/** Not there, or not the caller's to see: one answer, so existence is never disclosed. */
export const fileNotFound = (): AppError => new AppError('not_found', 'no such file', { code: 'files.file_not_found' });

export interface FilesEvent {
  /** view_exported (37.12) is the workspace's name for an export made from a saved view, raised beside file_exported. */
  event: FileEventName | 'view_exported';
  resource: { type: string; id: string } | null;
  subjectMembershipId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export async function recordEvent(db: Queryable, actor: Pick<Actor, 'organisationId' | 'audit'>, correlationId: string, e: FilesEvent): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: actor.audit, subjectMembershipId: e.subjectMembershipId ?? null, scopeId: null, resource: e.resource,
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: actor.organisationId, topic: auditEventMessage.topic, orderingKey: actor.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}
