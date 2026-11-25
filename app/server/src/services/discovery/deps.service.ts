// What discovery runs on, and its shared rules: decisions through policy, the switch that
// makes the service unreachable when off (spec 19.1), and audit events written to the outbox
// in the transaction that made the change (spec 9.2).

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { DiscoveryEvent } from '../../contracts/discovery/events.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { discoverySettingRepo } from '../../repos/connect/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { DiscoveryAgentChannel } from './agent.service.ts';
import type { ScanSigner } from './scans.service.ts';

export interface DiscoveryDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  agent: DiscoveryAgentChannel;
  /** Signs each scan the agent runs (spec 10.5). */
  scans: ScanSigner;
  /** A run with no report for this long has lost its agent. */
  silentMs: number;
}

export interface Context {
  request: RequestContext;
  correlationId: string;
}

export async function permitted(deps: DiscoveryDeps, ctx: Context, permission: string, organisationWide = false): Promise<boolean> {
  if (ctx.request.membershipId === undefined) return false;
  const decision = await deps.services.call(authorise, {
    body: { permission, ...(organisationWide ? { organisationWide: true as const } : {}) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return decision.decision === 'allow';
}

/** One of the permissions, or refused naming them. */
export async function demand(deps: DiscoveryDeps, ctx: Context, permissions: readonly (string | { permission: string; organisationWide: true })[]): Promise<void> {
  for (const p of permissions) {
    if (typeof p === 'string' ? await permitted(deps, ctx, p) : await permitted(deps, ctx, p.permission, true)) return;
  }
  const names = permissions.map((p) => (typeof p === 'string' ? p : `${p.permission} (organisation-wide)`));
  throw new AppError('forbidden', `you need ${names.join(' or ')}`, { code: 'discovery.not_permitted', details: { permission: names.join(',') } });
}

export const memberOf = (ctx: Context): string => {
  if (ctx.request.membershipId === undefined) throw new AppError('forbidden', 'discovery is directed by a member', { code: 'discovery.member_required' });
  return ctx.request.membershipId;
};

/** Off means unreachable (spec 19.1): every request but the switch's own is refused. */
export async function enabledOrRefuse(deps: DiscoveryDeps, ctx: Context): Promise<void> {
  const settings = await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => discoverySettingRepo.findByOrganisationId(db, ctx.request.organisationId!), { readOnly: true });
  if (settings?.enabled !== true) {
    throw new AppError('forbidden', 'discovery is off for this organisation', { code: 'discovery.disabled' });
  }
}

export interface DiscoveryEventInput {
  organisationId: string;
  correlationId: string;
  request: RequestContext;
  event: DiscoveryEvent;
  resource: { type: 'discovery_authorisation' | 'discovery_run' | 'discovery_finding'; id: string } | null;
  detail?: Record<string, string | number | boolean | null>;
}

/** Call inside the transaction that made the change. */
export async function recordDiscoveryEvent(db: Queryable, input: DiscoveryEventInput): Promise<void> {
  const actor: AuditActor = input.request.membershipId !== undefined
    ? { kind: 'membership', membershipId: input.request.membershipId }
    : { kind: 'service', service: 'discovery' };
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor, subjectMembershipId: null, scopeId: null, resource: input.resource, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail: input.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}
