// Live subscriptions (spec 24.3, 30.1, 30.5, 30.6).
//
// open: the holder's bounds first (concurrent subscriptions and subscribed objects per user,
// from clone.live_subscriptions), then the set resolved under the holder's permissions; the
// subscription joins the group for its set and permission fingerprint, or creates it by a
// bounded backfill (deltas observed after the read began are applied over it), passing the
// per-subscription and per-organisation bounds or being refused with them, never partially
// subscribed. A refusal on a bound is audited (subscription_refused_bound). The group's
// snapshot is published to the subscriber, and the subscription recorded (metadata only)
// so a lost replica can be told from a live one, and audited (subscription_opened: the set,
// its source and counts; subscription_closed when it ends).
//
// renew: the gateway's heartbeat. A subscription lapses 60 seconds after the last; the
// group, its objects and the change interest behind it 15 minutes after the last renewal.
// close: the viewer unsubscribed; the group's state ages out with the TTL.
//
// Subscribable (decision 2026-11-15): a set whose source object's stream has not passed the
// change-stream class is refused (not_subscribable), unless an admin lets it be polled: then
// it is subscribed as polled, every N minutes, and its source status says it is not live.
//
// A replica keeps the subscriptions it opened in memory, for the policy watch, source status
// and mode watch (workers/state-plane). Replay within a window is not offered: a client that
// reconnects with a sequence is sent a snapshot (spec 30.6 allows resync_required).

import { entitlementRepo } from '../../repos/billing/index.repo.ts';
import { getStreamStatus } from '../../contracts/change-stream/stream.contract.ts';
import type { SetReference } from '../../contracts/gateway/live.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { liveIndexKeys, subscriptionGroupKeys, subscriptionKeys } from '../../infra/keyspaces.infra.ts';
import { liveSubscriptionRepo } from '../../repos/clone/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { recordRefusedBounds, recordSubscription, type StatePlaneDeps } from './deps.service.ts';
import type { DeltaApplier } from './deltas.service.ts';
import type { GroupStore } from './groups.service.ts';
import { uuidFromHash } from './objectIds.service.ts';
import { LIVE_BOUNDS, resolveSet } from './resolver.service.ts';
import { sourceStatusOf } from './sourceStatus.service.ts';

export interface Holder {
  organisationId: string;
  membershipId: string;
  userId: string | undefined;
  sessionId: string;
}

export type OpenOutcome =
  | {
    outcome: 'subscribed'; groupId: string; objectCount: number; sources: string[]; fields: { granted: string[]; withheld: string[] };
    mode: 'live' | 'polled'; refreshEverySeconds: number | null;
  }
  | { outcome: 'refused'; reason: 'bound' | 'unresolvable' | 'permission' | 'not_subscribable'; bound?: string; limit?: number; count?: number };

/** What this replica remembers of a subscription it opened. */
export interface HeldSubscription {
  subscriptionId: string;
  rowId: string;
  holder: Holder;
  groupId: string;
  set: SetReference;
  requested: string[];
  fingerprint: string;
  granted: string[];
  connectionId: string;
  sourceObject: string;
  /** Polled by an admin's fallback, this often; null when live. */
  refreshEverySeconds: number | null;
  lastHeartbeatWrite: number;
}

const SUBSCRIBER_TTL = 60;
const LAPSED_AFTER_MS = 2 * 60 * 1000;
const HEARTBEAT_WRITE_MS = 60 * 1000;
const OBJECT_TOUCH_MS = 5 * 60 * 1000;

export const rowIdOf = (subscriptionId: string): string => uuidFromHash('live_subscription', subscriptionId);

export const requestOf = (holder: Holder): RequestContext => ({
  organisationId: holder.organisationId, membershipId: holder.membershipId, sessionId: holder.sessionId,
  ...(holder.userId === undefined ? {} : { userId: holder.userId }),
});

export function createSubscriptions(deps: StatePlaneDeps, groups: GroupStore, applier: DeltaApplier) {
  const control = deps.databases.pool('control');
  const held = new Map<string, HeldSubscription>();
  const objectsTouched = new Map<string, number>();

  async function refuseBound(holder: Holder, set: SetReference, correlationId: string, bound: string, limit: number, count?: number): Promise<OpenOutcome> {
    await inTransaction(control, requestOf(holder), (db) => recordRefusedBounds(db, {
      organisationId: holder.organisationId, membershipId: holder.membershipId, correlationId, bound, limit, count, setId: set.id,
    })).catch((error: unknown) => deps.logger.failure('a bound refusal could not be audited', error, { event: 'live.audit_failed' }));
    return { outcome: 'refused', reason: 'bound', bound, limit, ...(count === undefined ? {} : { count }) };
  }

  async function open(holder: Holder, input: { subscriptionId: string; set: SetReference; properties: string[] }, correlationId: string)
    : Promise<OpenOutcome> {
    const request = requestOf(holder);
    const active = await inTransaction(control, request, (db) =>
      liveSubscriptionRepo.activeForMembership(db, holder.membershipId, new Date(Date.now() - LAPSED_AFTER_MS).toISOString()), { readOnly: true });
    if (active.subscriptions >= LIVE_BOUNDS.subscriptionsPerUser) {
      return refuseBound(holder, input.set, correlationId, 'subscriptions_per_user', LIVE_BOUNDS.subscriptionsPerUser, active.subscriptions);
    }
    const resolution = await resolveSet(deps.services, request, input.set, input.properties, correlationId);
    if (resolution.outcome === 'refused') {
      return resolution.reason === 'bound'
        ? refuseBound(holder, input.set, correlationId, resolution.bound ?? 'bound', resolution.limit ?? 0, resolution.count)
        : resolution;
    }
    const { plan } = resolution;
    // Live, polled by an admin's fallback, or not subscribable (decision 2026-11-15).
    const stream = await deps.services.call(getStreamStatus, { params: { connectionId: plan.connectionId } }, { request, correlationId });
    const streamed = stream.objects.find((o) => o.object === plan.sourceObject);
    if (streamed === undefined || streamed.mode === 'unavailable') return { outcome: 'refused', reason: 'not_subscribable' };
    const refreshEverySeconds = streamed.mode === 'polled' ? streamed.refreshEverySeconds : null;
    const groupId = uuidFromHash(holder.organisationId, resolution.objectSetHash, resolution.fingerprint);
    let group = await groups.read(holder.organisationId, groupId);
    if (group === undefined) {
      let snapshot;
      try {
        snapshot = await resolution.read();
      } catch (error) {
        if ((error as { liveBound?: boolean }).liveBound === true || (isAppError(error) && error.category === 'bounds')) {
          return refuseBound(holder, input.set, correlationId, 'objects_per_subscription', LIVE_BOUNDS.objectsPerSubscription);
        }
        throw error;
      }
      const live = await deps.state.countMembers(liveIndexKeys, liveIndexKeys.key(holder.organisationId));
      // The organisation's bound: its contract's where one sets it (9.5), else the cell's default.
      const organisationBound = (await inTransaction(control, request, (db) => entitlementRepo.findOpen(db, holder.organisationId), { readOnly: true }))
        ?.liveObjectsLimit ?? LIVE_BOUNDS.objectsPerOrganisation;
      if (live + snapshot.objects.length > organisationBound) {
        return refuseBound(holder, input.set, correlationId, 'live_objects_per_organisation', organisationBound, live + snapshot.objects.length);
      }
      if (active.objects + snapshot.objects.length > LIVE_BOUNDS.objectsPerUser) {
        return refuseBound(holder, input.set, correlationId, 'objects_per_user', LIVE_BOUNDS.objectsPerUser, active.objects + snapshot.objects.length);
      }
      await groups.create(holder.organisationId, groupId, resolution, plan, snapshot.objects, new Date(snapshot.readStartedAt).toISOString());
      await applier.drainPending(holder.organisationId, plan.connectionId, plan.sourceObject, snapshot.readStartedAt);
      group = { groupId, plan, subscriberCount: 0, objectCount: snapshot.objects.length };
    } else if (active.objects + group.objectCount > LIVE_BOUNDS.objectsPerUser) {
      return refuseBound(holder, input.set, correlationId, 'objects_per_user', LIVE_BOUNDS.objectsPerUser, active.objects + group.objectCount);
    }

    await deps.state.putHash(subscriptionKeys, subscriptionKeys.key(holder.organisationId, { subscriptionId: input.subscriptionId }), {
      groupId, holderKind: 'session', holderId: holder.membershipId, sessionId: holder.sessionId, lastAckedSeq: 0,
      connectedAt: new Date().toISOString(), bufferMode: 'live',
    }, { ttlSeconds: SUBSCRIBER_TTL });
    await deps.state.incrementField(subscriptionGroupKeys, groups.groupKey(holder.organisationId, groupId), 'subscriberCount', 1);
    const rowId = rowIdOf(input.subscriptionId);
    await inTransaction(control, request, (db) => liveSubscriptionRepo.insert(db, {
      id: rowId, organisationId: holder.organisationId, holderKind: 'session', membershipId: holder.membershipId, sessionId: holder.sessionId,
      objectSetRef: input.set.id, propertyIds: group.plan.properties.map((p) => p.identityId), projectionHash: resolution.projectionHash,
      objectCount: group.objectCount, connectionIds: [group.plan.connectionId], statePlaneNode: deps.node,
    }));
    held.set(input.subscriptionId, {
      subscriptionId: input.subscriptionId, rowId, holder, groupId, set: input.set, requested: [...input.properties],
      fingerprint: resolution.fingerprint, granted: group.plan.properties.map((p) => p.apiName), connectionId: group.plan.connectionId,
      sourceObject: group.plan.sourceObject, refreshEverySeconds, lastHeartbeatWrite: Date.now(),
    });
    await groups.snapshot(holder.organisationId, groupId, group.plan, input.subscriptionId);
    groups.publish(holder.organisationId, groupId, {
      type: 'source_status', sources: [await sourceStatusOf(deps.state, holder.organisationId, group.plan.connectionId, Date.now(),
        refreshEverySeconds === null ? undefined : { sourceObject: group.plan.sourceObject, refreshEverySeconds })],
    }, input.subscriptionId);
    // Audited once the viewer has its snapshot, so the audit write never delays what they see.
    const opened = group;
    await inTransaction(control, request, (db) => recordSubscription(db, {
      organisationId: holder.organisationId, membershipId: holder.membershipId, correlationId, event: 'subscription_opened', set: input.set,
      detail: { subscription_id: rowId, connection_id: opened.plan.connectionId, source_object: opened.plan.sourceObject, objects: opened.objectCount,
        properties: opened.plan.properties.length, mode: refreshEverySeconds === null ? 'live' : 'polled' },
    }));
    return {
      outcome: 'subscribed', groupId, objectCount: group.objectCount, sources: [group.plan.connectionId],
      fields: { granted: group.plan.properties.map((p) => p.apiName), withheld: group.plan.withheld },
      mode: refreshEverySeconds === null ? 'live' : 'polled', refreshEverySeconds,
    };
  }

  async function close(holder: Holder, subscriptionId: string, reason: 'closed' | 'revoked' = 'closed'): Promise<boolean> {
    const key = subscriptionKeys.key(holder.organisationId, { subscriptionId });
    const sub = await deps.state.readHash(subscriptionKeys, key);
    const was = held.get(subscriptionId);
    held.delete(subscriptionId);
    await inTransaction(control, requestOf(holder), async (db) => {
      // Audited once, by whichever replica ends the row.
      if (!await liveSubscriptionRepo.end(db, rowIdOf(subscriptionId), reason)) return;
      await recordSubscription(db, {
        organisationId: holder.organisationId, membershipId: holder.membershipId, correlationId: rowIdOf(subscriptionId), event: 'subscription_closed',
        set: was?.set, detail: { subscription_id: rowIdOf(subscriptionId), reason, ...(was === undefined ? {} : { connection_id: was.connectionId }) },
      });
    });
    if (sub === undefined || sub.holderId !== holder.membershipId) return false;
    await deps.state.remove(subscriptionKeys, key);
    await deps.state.incrementField(subscriptionGroupKeys, groups.groupKey(holder.organisationId, sub.groupId), 'subscriberCount', -1).catch(() => undefined);
    return true;
  }

  async function renew(holder: Holder, subscriptions: { subscriptionId: string; ackedSeq?: number | undefined }[])
    : Promise<{ renewed: string[]; ended: string[] }> {
    const renewed: string[] = [];
    const ended: string[] = [];
    const beats: string[] = [];
    for (const { subscriptionId, ackedSeq } of subscriptions) {
      const key = subscriptionKeys.key(holder.organisationId, { subscriptionId });
      const sub = await deps.state.readHash(subscriptionKeys, key);
      if (sub === undefined || sub.holderId !== holder.membershipId) {
        ended.push(subscriptionId);
        continue;
      }
      await deps.state.touch(subscriptionKeys, key, SUBSCRIBER_TTL);
      if (ackedSeq !== undefined) await deps.state.setFields(subscriptionKeys, key, { lastAckedSeq: ackedSeq });
      const plan = await groups.planOf(holder.organisationId, sub.groupId);
      if (plan === undefined) {
        ended.push(subscriptionId);
        continue;
      }
      const touchedAt = objectsTouched.get(sub.groupId) ?? 0;
      const touchObjects = Date.now() - touchedAt > OBJECT_TOUCH_MS;
      if (touchObjects) objectsTouched.set(sub.groupId, Date.now());
      await groups.renew(holder.organisationId, sub.groupId, plan, touchObjects);
      renewed.push(subscriptionId);
      const mine = held.get(subscriptionId);
      if (mine === undefined || Date.now() - mine.lastHeartbeatWrite > HEARTBEAT_WRITE_MS) {
        beats.push(rowIdOf(subscriptionId));
        if (mine !== undefined) mine.lastHeartbeatWrite = Date.now();
      }
    }
    if (beats.length > 0) await inTransaction(control, requestOf(holder), (db) => liveSubscriptionRepo.heartbeat(db, beats));
    return { renewed, ended };
  }

  /**
   * The gateway's report that a subscriber fell behind and entered snapshot mode (spec 30.4),
   * or caught up: entering it is audited (subscription_snapshot_mode), since the clone then
   * shows the latest state every two seconds, not each change.
   */
  async function bufferMode(holder: Holder, subscriptionId: string, mode: 'snapshot' | 'live'): Promise<{ recorded: boolean }> {
    if (mode !== 'snapshot') return { recorded: false };
    const sub = await deps.state.readHash(subscriptionKeys, subscriptionKeys.key(holder.organisationId, { subscriptionId }));
    if (sub === undefined || sub.holderId !== holder.membershipId) return { recorded: false };
    const mine = held.get(subscriptionId);
    await inTransaction(control, requestOf(holder), (db) => recordSubscription(db, {
      organisationId: holder.organisationId, membershipId: holder.membershipId, correlationId: rowIdOf(subscriptionId), event: 'subscription_snapshot_mode',
      set: mine?.set, detail: { subscription_id: rowIdOf(subscriptionId), ...(mine === undefined ? {} : { connection_id: mine.connectionId }) },
    }));
    return { recorded: true };
  }

  return { open, close, renew, held, bufferMode };
}

export type Subscriptions = ReturnType<typeof createSubscriptions>;
