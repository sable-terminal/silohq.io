// What the state plane runs on, and its audit events.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import type { LiveBus } from '../../infra/bus.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface StatePlaneDeps {
  cellId: string;
  /** This replica, recorded on each subscription it opens (clone.live_subscriptions.state_plane_node). */
  node: string;
  databases: Databases;
  services: ServiceClient;
  /** redis-state, persistence disabled: live state, groups, subscriptions, interest. */
  state: RedisStore;
  liveBus: LiveBus;
  logger: Logger;
}

/** subscription_refused_bound (spec 24.9): the bound and the counts, never the set's contents. */
export async function recordRefusedBounds(db: Queryable, input: {
  organisationId: string; membershipId: string; correlationId: string; bound: string; limit: number; count?: number | undefined; setId: string;
}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: 'subscription_refused_bound', actor: { kind: 'membership', membershipId: input.membershipId }, subjectMembershipId: null,
    scopeId: null, resource: { type: 'object_set', id: input.setId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
    detail: { bound: input.bound, limit: input.limit, ...(input.count === undefined ? {} : { count: input.count }) },
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}

/**
 * subscription_opened and subscription_closed (spec 32.7): the set, its source connection and
 * object, how many objects and whether live or polled; never the set's contents.
 */
export async function recordSubscription(db: Queryable, input: {
  organisationId: string;
  /** The holder: the actor, or, where the state plane acted on its own (a policy change, a resync), the subject. */
  membershipId: string | undefined; correlationId: string;
  event: 'subscription_opened' | 'subscription_closed' | 'subscription_projection_changed' | 'subscription_resynced' | 'subscription_snapshot_mode';
  set: { kind: 'view' | 'object_set'; id: string } | undefined; detail: Record<string, string | number | boolean>;
  byStatePlane?: boolean;
}): Promise<void> {
  const ownAct = input.byStatePlane === true || input.membershipId === undefined;
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor: ownAct ? { kind: 'service', service: 'state-plane' } : { kind: 'membership', membershipId: input.membershipId },
    subjectMembershipId: ownAct ? input.membershipId ?? null : null, scopeId: null,
    resource: input.set === undefined ? null : { type: input.set.kind === 'view' ? 'view' : 'object_set', id: input.set.id },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: input.detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}

/**
 * source_declared_stale and source_recovered (spec 32.7): clones of a source stopped being
 * current, or became current again; the source, how many objects and subscriptions, and how
 * long. Recorded by the replica holding them.
 */
export async function recordSourceStatus(db: Queryable, input: {
  organisationId: string; event: 'source_declared_stale' | 'source_recovered'; connectionId: string; detail: Record<string, string | number | boolean>;
}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: input.event, actor: { kind: 'service', service: 'state-plane' }, subjectMembershipId: null, scopeId: null,
    resource: { type: 'connection', id: input.connectionId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: input.detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: uuidv7(),
  });
}

/** stream_coalesced (spec 18.4, 18.10): a connection's changes passed its rate, so its clones show the latest each second. */
export async function recordCoalescing(db: Queryable, input: {
  organisationId: string; connectionId: string; rate: number; threshold: number; node: string;
}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: 'stream_coalesced', actor: { kind: 'service', service: 'state-plane' }, subjectMembershipId: null, scopeId: null,
    resource: { type: 'connection', id: input.connectionId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
    detail: { rate: input.rate, threshold: input.threshold, node: input.node },
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: uuidv7(),
  });
}

/** stream_backfill_completed (spec 18.7, 18.10): a group read again after its stream recovered or lost changes; counts only. */
export async function recordBackfilled(db: Queryable, input: {
  organisationId: string; correlationId: string; connectionId: string; objects: number; subscriptions: number; reason: 'recovered' | 'gap';
}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: 'stream_backfill_completed', actor: { kind: 'service', service: 'state-plane' }, subjectMembershipId: null, scopeId: null,
    resource: { type: 'connection', id: input.connectionId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
    detail: { objects: input.objects, subscriptions: input.subscriptions, reason: input.reason },
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: auditEventMessage.topic, orderingKey: input.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: input.correlationId,
  });
}
