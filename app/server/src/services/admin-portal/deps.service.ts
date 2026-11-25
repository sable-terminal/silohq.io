// What every part of the admin portal shares (spec 7 catalogue, 13): its dependencies, the
// member of staff a request comes from, and break-glass events in the customer's audit log.

import type { AdminPortalConfig } from '../../config/adminPortal.config.ts';
import type { StaffCapability } from '../../contracts/admin-portal/capability.contract.ts';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { Egress } from '../../infra/egress.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Operator } from '../../models/platform/operator.model.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface AdminPortalDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  config: AdminPortalConfig;
  /** This cell; a sovereign cell always needs the customer's approval and the sovereign access list (13.3). */
  cell: { id: string; sovereign: boolean };
  /** redis-session: staff sessions. */
  sessions: RedisStore;
  /** redis-data: sign-in flows and rate limits. */
  data: RedisStore;
  /** The staff identity provider is reached through the cell's egress. */
  egress: Egress;
  now?: () => Date;
}

export const nowOf = (deps: Pick<AdminPortalDeps, 'now'>): Date => deps.now?.() ?? new Date();

/** The member of staff a request comes from: their row as it is now, and what their groups let them do. */
export interface Staff {
  operator: Operator;
  capabilities: ReadonlySet<StaffCapability>;
  /** The staff session's key, for the per-session rate limit. */
  sessionKey: string;
  absoluteExpiresAt: string;
}

export interface StaffContext {
  staff: Staff;
  correlationId: string;
}

export const holds = (staff: Staff, capability: StaffCapability): boolean => staff.capabilities.has(capability);

export function requireCapability(staff: Staff, capability: StaffCapability): void {
  if (!holds(staff, capability)) {
    throw new AppError('forbidden', `this needs the staff capability ${capability}`, { code: 'staff.not_permitted', details: { capability } });
  }
}

/**
 * A break-glass event in the customer's audit log (spec 13.5, 63.6), in the transaction that
 * made the change. It carries the session whoever acted. References and counts only.
 */
export async function recordAccessEvent(db: Queryable, e: {
  organisationId: string; correlationId: string; sessionId: string;
  event: 'operator_access_requested' | 'operator_access_approved' | 'operator_access_denied' | 'operator_access_started'
    | 'operator_access_resource_touched' | 'operator_access_used' | 'operator_access_ended' | 'operator_access_expired' | 'operator_access_emergency';
  actor: AuditActor;
  resource?: { type: string; id: string };
  detail?: Record<string, string | number | boolean | null | string[]>;
}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: e.actor, subjectMembershipId: null, scopeId: null,
    resource: e.resource ?? { type: 'operator_access_session', id: e.sessionId },
    purposeSessionId: null, operatorAccessSessionId: e.sessionId, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, topic: auditEventMessage.topic, orderingKey: e.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: e.correlationId,
  });
}
