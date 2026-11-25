// What change-stream runs on, and its audit events.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { SourceChange } from '../../contracts/change-stream/delta.contract.ts';
import type { ChangeStreamEvent } from '../../contracts/change-stream/events.contract.ts';
import type { LiveBus } from '../../infra/bus.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface ChangeStreamDeps {
  cellId: string;
  databases: Databases;
  services: ServiceClient;
  /** redis-state: interest, watermarks, stream health, de-duplication. */
  state: RedisStore;
  /** redis-data: change epochs for result-cache invalidation, and locks. */
  data: RedisStore;
  liveBus: LiveBus;
  logger: Logger;
  /** Email fallback (spec 14.4): the domain addresses are minted under, and the relay's signing secret. */
  inboundEmail?: { domain: string; secret: string } | undefined;
  /** Accepted changes queued to Capture too (spec 30.7), without waiting. */
  capture?: { capture(organisationId: string, connectionId: string, changes: readonly SourceChange[]): Promise<number> };
}

export interface StreamEventInput {
  organisationId: string;
  correlationId: string;
  event: ChangeStreamEvent;
  /** The member who acted; else change-stream acting on its own (a stream going stale). */
  membershipId?: string | undefined;
  connectionId: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** Call inside a transaction with the organisation's context (spec 9.2). */
export async function recordStreamEvent(db: Queryable, input: StreamEventInput): Promise<void> {
  const actor: AuditActor = input.membershipId !== undefined
    ? { kind: 'membership', membershipId: input.membershipId } : { kind: 'service', service: 'change-stream' };
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor, subjectMembershipId: null, scopeId: null, resource: { type: 'connection', id: input.connectionId },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: input.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}
