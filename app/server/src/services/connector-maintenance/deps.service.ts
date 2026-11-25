// What connector-maintenance runs on, and its shared rules: who may ask for a re-check, see
// its findings and review a repair (the connection's owner, or the permission at the
// connection's owning scope, decided by policy); and its audit events, written to the outbox
// in the transaction that made the change (spec 9.2).
//
// The service acts in two ways. A person asks (a re-check, a decision): the request carries
// their membership and session, and policy decides. The weekly re-check and a runtime
// self-heal run on their own: the request carries the organisation only, and every event
// names the service as the actor.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { MaintenanceEvent } from '../../contracts/connector-maintenance/events.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import { connectionRepo } from '../../repos/connect/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface MaintenanceDeps {
  databases: Databases;
  services: ServiceClient;
  /** redis-data: the per-connection re-check lock. */
  data: RedisStore;
  logger: Logger;
  /** How long a re-check waits for its conformance run, and a sandbox for its run. */
  runTimeoutMs: number;
  /** How often a run in progress is read back. */
  pollMs: number;
  /** Aborted when the process stops: work in flight ends, recorded as stopped. */
  signal: AbortSignal;
}

export interface Context {
  request: RequestContext;
  correlationId: string;
}

/** A person, or the service on its own. */
export const isPerson = (ctx: Context): boolean => ctx.request.membershipId !== undefined;

export async function loadConnection(deps: MaintenanceDeps, ctx: Context, connectionId: string): Promise<Connection> {
  const connection = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectionRepo.findById(db, connectionId), { readOnly: true });
  if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
  return connection;
}

/**
 * The connection's owner, or a holder of one of the permissions at its owning scope. The
 * service acting on its own needs no decision; nothing reaches it from outside but its own work.
 */
export async function demandOn(deps: MaintenanceDeps, ctx: Context, connection: Connection, permissions: readonly string[]): Promise<void> {
  if (!isPerson(ctx)) return;
  if (connection.owningMembershipId === ctx.request.membershipId) return;
  for (const permission of permissions) {
    const decision = await deps.services.call(authorise, {
      body: { permission, scopeId: connection.owningScopeId, resource: { type: 'connection', id: connection.id } },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    if (decision.decision === 'allow') return;
  }
  throw new AppError('forbidden', `you need ${permissions.join(' or ')} on this connection`, {
    code: 'maintenance.not_permitted', details: { permission: permissions.join(',') },
  });
}

export interface MaintenanceEventInput {
  organisationId: string;
  correlationId: string;
  request: RequestContext;
  /** connection_halted and connector_manifest_versioned are Connect's own events, raised here for a halt and a repair. */
  event: MaintenanceEvent | 'connection_halted' | 'connector_manifest_versioned';
  resource: { type: 'heal_proposal' | 'connection' | 'manifest'; id: string };
  detail?: Record<string, string | number | boolean | null>;
}

/** Call inside the transaction that made the change. */
export async function recordMaintenanceEvent(db: Queryable, input: MaintenanceEventInput): Promise<void> {
  const actor: AuditActor = input.request.membershipId !== undefined
    ? { kind: 'membership', membershipId: input.request.membershipId }
    : { kind: 'service', service: 'connector-maintenance' };
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor, subjectMembershipId: null, scopeId: null, resource: input.resource, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail: input.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}
