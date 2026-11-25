// Live state and subscription groups in redis-state (spec 24.3, 30.1, 30.2).
//
// A group is one per set and permission fingerprint: subscribers to the same set share it
// only when their permissions match, so values are never shared across permissions. It
// holds its plan (names and ids), its sequence, its subscriber count and its objects.
//
// An object's live state is one hash, st:{org}:o:<object>: per property identity and
// source, the latest value and when it was received (p:<identity>:<connection>), and per
// source the last applied sequence (q:<connection>). Several groups may hold one object;
// each sends only its own granted properties. The source key of each object resolves to it
// by an exact match (st:{org}:m:...), so a delta finds its object without the entity
// graph. Everything expires 15 minutes after the last interest (spec 24.6); nothing is
// written anywhere that persists (spec 30.7).
//
// Frames go to the gateway on bus-live, sub.<organisation>.<group>, as liveGroupFrame: a
// frame naming a subscription is for that subscriber alone (its snapshot).

import { liveGroupFrame, type GroupFrame } from '../../contracts/gateway/live.contract.ts';
import { liveSubjects } from '../../infra/bus.infra.ts';
import {
  liveIndexKeys, liveMatchKeys, liveObjectKeys, objectGroupKeys, registerChangeInterest, subscriptionGroupKeys, subscriptionGroupObjectKeys,
} from '../../infra/keyspaces.infra.ts';
import { LIMITS } from '../../config/limits.config.ts';
import type { StatePlaneDeps } from './deps.service.ts';
import { sourceKeyHash } from './objectIds.service.ts';
import type { GroupPlan, ResolvedObject } from './resolver.service.ts';

const IDLE = LIMITS.statePlane.idleTtl;
/** A snapshot frame stays well inside the 256 KB live message bound. */
const SNAPSHOT_FRAME_BYTES = 192 * 1024;
const SNAPSHOT_FRAME_OBJECTS = 1_000;

export const valueField = (identityId: string, connectionId: string): string => `p:${identityId}:${connectionId}`;
export const sequenceField = (connectionId: string): string => `q:${connectionId}`;

export interface HeldValue { v: unknown; at: string }

export function parseHeld(text: string | undefined): HeldValue | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as HeldValue;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.at === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface GroupRecord {
  groupId: string;
  plan: GroupPlan;
  subscriberCount: number;
  objectCount: number;
}

export function createGroupStore(deps: StatePlaneDeps) {
  const { state } = deps;
  const plans = new Map<string, { plan: GroupPlan; at: number }>();

  const groupKey = (organisationId: string, groupId: string) => subscriptionGroupKeys.key(organisationId, { groupId });

  async function read(organisationId: string, groupId: string): Promise<GroupRecord | undefined> {
    const hash = await state.readHash(subscriptionGroupKeys, groupKey(organisationId, groupId));
    if (hash === undefined || hash.plan === undefined) return undefined;
    let plan: GroupPlan;
    try {
      plan = JSON.parse(hash.plan) as GroupPlan;
    } catch {
      return undefined;
    }
    plans.set(groupId, { plan, at: Date.now() });
    return { groupId, plan, subscriberCount: hash.subscriberCount, objectCount: hash.objectCount };
  }

  /** The group's plan, from memory for up to 30 seconds (plans never change for a group). */
  async function planOf(organisationId: string, groupId: string): Promise<GroupPlan | undefined> {
    const cached = plans.get(groupId);
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.plan;
    return (await read(organisationId, groupId))?.plan;
  }

  async function nextSeq(organisationId: string, groupId: string, by = 1): Promise<number> {
    return state.incrementField(subscriptionGroupKeys, groupKey(organisationId, groupId), 'seq', by);
  }

  function publish(organisationId: string, groupId: string, frame: GroupFrame, subscription?: string): void {
    deps.liveBus.publish(liveGroupFrame, liveSubjects.subscription(organisationId, groupId), {
      group: groupId, frame, ...(subscription === undefined ? {} : { subscription }),
    });
  }

  /** Writes the snapshot's objects into live state, the group and its indexes; renews interest. */
  async function create(organisationId: string, groupId: string, hashes: { objectSetHash: string; fingerprint: string; projectionHash: string },
    plan: GroupPlan, objects: readonly ResolvedObject[], receivedAt: string): Promise<void> {
    const until = Date.now() + LIMITS.statePlane.absoluteTtl * 1000;
    for (const object of objects) {
      const fields: Record<string, string> = {};
      for (const [identityId, value] of object.values) {
        fields[valueField(identityId, plan.connectionId)] = JSON.stringify({ v: value, at: receivedAt } satisfies HeldValue);
      }
      const key = liveObjectKeys.key(organisationId, { objectId: object.objectId });
      // An object another group already holds is kept current by deltas: only what it does
      // not hold yet is filled in from this read.
      const held = await state.readHash(liveObjectKeys, key);
      if (held === undefined) await state.putHash(liveObjectKeys, key, fields, { ttlSeconds: IDLE });
      else {
        const missing = Object.fromEntries(Object.entries(fields).filter(([field]) => held[field] === undefined));
        if (Object.keys(missing).length > 0) await state.applyLiveFields(liveObjectKeys, key, undefined, missing, { ttlSeconds: IDLE });
      }
      await state.put(liveMatchKeys, liveMatchKeys.key(organisationId, {
        connectionId: plan.connectionId, sourceKeyHash: sourceKeyHash(plan.sourceObject, object.entityRef),
      }), object.objectId, { ttlSeconds: IDLE });
      await state.addMembers(objectGroupKeys, objectGroupKeys.key(organisationId, { objectId: object.objectId }), [groupId], { ttlSeconds: IDLE });
    }
    if (objects.length > 0) {
      await state.addScored(liveIndexKeys, liveIndexKeys.key(organisationId), objects.map((o) => ({ member: o.objectId, score: until })));
      await state.addMembers(subscriptionGroupObjectKeys, subscriptionGroupObjectKeys.key(organisationId, { groupId }), objects.map((o) => o.objectId),
        { ttlSeconds: IDLE });
    }
    await state.putHash(subscriptionGroupKeys, groupKey(organisationId, groupId), {
      objectSetHash: hashes.objectSetHash, permissionFingerprint: hashes.fingerprint, projectionHash: hashes.projectionHash,
      objectCount: objects.length, subscriberCount: 0, createdAt: receivedAt, seq: 0, plan: JSON.stringify(plan),
    }, { ttlSeconds: IDLE });
    plans.set(groupId, { plan, at: Date.now() });
    await registerChangeInterest(state, deps.cellId, organisationId, plan.connectionId, [plan.sourceObject]);
  }

  /**
   * A backfill after a stream outage or gap (spec 18.5, 18.7): the group's objects as read now.
   * A held value newer than the read (a change applied since it began) is kept; anything older
   * is replaced. Objects no longer in the set leave the group, new ones join it.
   */
  async function refresh(organisationId: string, groupId: string, plan: GroupPlan, objects: readonly ResolvedObject[], readStartedAt: string): Promise<void> {
    const readAt = Date.parse(readStartedAt);
    const until = Date.now() + LIMITS.statePlane.absoluteTtl * 1000;
    for (const object of objects) {
      const key = liveObjectKeys.key(organisationId, { objectId: object.objectId });
      const held = await state.readHash(liveObjectKeys, key);
      const fields: Record<string, string> = {};
      for (const [identityId, value] of object.values) {
        const field = valueField(identityId, plan.connectionId);
        const was = parseHeld(held?.[field]);
        if (was !== undefined && Date.parse(was.at) > readAt) continue;
        fields[field] = JSON.stringify({ v: value, at: readStartedAt } satisfies HeldValue);
      }
      if (held === undefined) await state.putHash(liveObjectKeys, key, fields, { ttlSeconds: IDLE });
      else if (Object.keys(fields).length > 0) await state.applyLiveFields(liveObjectKeys, key, undefined, fields, { ttlSeconds: IDLE });
      await state.put(liveMatchKeys, liveMatchKeys.key(organisationId, {
        connectionId: plan.connectionId, sourceKeyHash: sourceKeyHash(plan.sourceObject, object.entityRef),
      }), object.objectId, { ttlSeconds: IDLE });
      await state.addMembers(objectGroupKeys, objectGroupKeys.key(organisationId, { objectId: object.objectId }), [groupId], { ttlSeconds: IDLE });
    }
    const membersKey = subscriptionGroupObjectKeys.key(organisationId, { groupId });
    const now = new Set(objects.map((o) => o.objectId));
    const gone = (await state.members(subscriptionGroupObjectKeys, membersKey)).filter((id) => !now.has(id));
    for (const objectId of gone) await state.removeMembers(objectGroupKeys, objectGroupKeys.key(organisationId, { objectId }), [groupId]);
    await state.removeMembers(subscriptionGroupObjectKeys, membersKey, gone);
    if (objects.length > 0) {
      await state.addScored(liveIndexKeys, liveIndexKeys.key(organisationId), objects.map((o) => ({ member: o.objectId, score: until })));
      await state.addMembers(subscriptionGroupObjectKeys, membersKey, objects.map((o) => o.objectId), { ttlSeconds: IDLE });
    }
    await state.setFields(subscriptionGroupKeys, groupKey(organisationId, groupId), { objectCount: objects.length });
  }

  /** Re-arms the group, its objects and the change interest behind it (spec 24.6: 15 minutes after the last interest). */
  async function renew(organisationId: string, groupId: string, plan: GroupPlan, objects: boolean): Promise<void> {
    await state.touch(subscriptionGroupKeys, groupKey(organisationId, groupId), IDLE);
    await state.touch(subscriptionGroupObjectKeys, subscriptionGroupObjectKeys.key(organisationId, { groupId }), IDLE);
    await registerChangeInterest(state, deps.cellId, organisationId, plan.connectionId, [plan.sourceObject]);
    if (!objects) return;
    for (const objectId of await state.members(subscriptionGroupObjectKeys, subscriptionGroupObjectKeys.key(organisationId, { groupId }))) {
      await state.touch(liveObjectKeys, liveObjectKeys.key(organisationId, { objectId }), IDLE);
      await state.touch(objectGroupKeys, objectGroupKeys.key(organisationId, { objectId }), IDLE);
    }
  }

  /** The group's state as snapshot frames for one subscriber (spec 30.3: paged full state). */
  async function snapshot(organisationId: string, groupId: string, plan: GroupPlan, subscription: string): Promise<number> {
    const seq = await nextSeq(organisationId, groupId);
    const ids = await state.members(subscriptionGroupObjectKeys, subscriptionGroupObjectKeys.key(organisationId, { groupId }));
    const now = Date.now();
    type SnapshotObject = Extract<GroupFrame, { type: 'snapshot' }>['objects'][number];
    let page = 0;
    let batch: SnapshotObject[] = [];
    let bytes = 0;
    const flush = (last: boolean): void => {
      publish(organisationId, groupId, { type: 'snapshot', seq, page, last, objects: batch }, subscription);
      page += 1;
      batch = [];
      bytes = 0;
    };
    for (const objectId of ids.sort()) {
      const held = await state.readHash(liveObjectKeys, liveObjectKeys.key(organisationId, { objectId }));
      if (held === undefined) continue;
      const values: SnapshotObject['values'] = [];
      for (const p of plan.properties) {
        const value = parseHeld(held[valueField(p.identityId, p.connectionId)]);
        if (value === undefined) continue;
        values.push({ property: p.apiName, value: value.v as never, source: p.connectionId, ageMs: Math.max(0, now - Date.parse(value.at)) });
      }
      const entry: SnapshotObject = { object: objectId, values };
      const size = JSON.stringify(entry).length;
      if (batch.length > 0 && (batch.length >= SNAPSHOT_FRAME_OBJECTS || bytes + size > SNAPSHOT_FRAME_BYTES)) flush(false);
      batch.push(entry);
      bytes += size;
    }
    flush(true);
    return seq;
  }

  return { read, planOf, nextSeq, publish, create, refresh, renew, snapshot, groupKey };
}

export type GroupStore = ReturnType<typeof createGroupStore>;
