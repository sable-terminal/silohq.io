// Applying a source change to live state and fanning it out (spec 18.6, 24.3, 30.2, 30.3).
//
// 1. Resolution by exact match: the change's source key names the object it was resolved
//    to when the set was read. A change for an entity not held yet is kept a minute, for a
//    backfill in progress to apply (spec 18.5); otherwise it is dropped and counted.
// 2. Ordering per entity: a change no newer than the last applied for its source (by source
//    sequence where the manifest orders by it, else by when it was observed) is dropped.
// 3. Every group holding the object gets a delta with the properties it is granted, under
//    its own next sequence; a group whose filter the object no longer meets is told it left
//    (the canvas keeps it, marked, spec 30.3), and told again if it comes back. A deletion
//    at the source is a departure from every group.
// Values pass through memory and redis-state only; nothing is logged but counts.

import type { SourceChange } from '../../contracts/change-stream/delta.contract.ts';
import type { Change, GroupFrame } from '../../contracts/gateway/live.contract.ts';
import { liveMatchKeys, liveObjectKeys, livePendingKeys, objectGroupKeys } from '../../infra/keyspaces.infra.ts';
import type { StatePlaneDeps } from './deps.service.ts';
import { parseHeld, sequenceField, valueField, type GroupStore, type HeldValue } from './groups.service.ts';
import { sourceKeyHash } from './objectIds.service.ts';
import { predicateOf, type GroupPlan, type PlanProperty } from './resolver.service.ts';

export type ApplyOutcome = 'applied' | 'pending' | 'stale' | 'absent' | 'bound' | 'unchanged';

const MAX_TEXT = 64 * 1024;

/** A value as a frame carries it: scalars as they are, anything structured as its JSON text. */
export function frameValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = JSON.stringify(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

const leftField = (groupId: string): string => `l:${groupId}`;

export function createDeltaApplier(deps: StatePlaneDeps, groups: GroupStore) {
  const { state } = deps;
  const predicates = new Map<string, ReturnType<typeof predicateOf>>();
  const testOf = (cel: string) => {
    let test = predicates.get(cel);
    if (test === undefined) {
      test = predicateOf(cel);
      if (predicates.size > 1_000) predicates.clear();
      predicates.set(cel, test);
    }
    return test;
  };

  async function applyToObject(objectId: string, delta: SourceChange, coalesced = 0): Promise<ApplyOutcome> {
    const organisationId = delta.organisationId;
    const objectKey = liveObjectKeys.key(organisationId, { objectId });
    const groupIds = await state.members(objectGroupKeys, objectGroupKeys.key(organisationId, { objectId }));
    const held: { groupId: string; plan: GroupPlan }[] = [];
    for (const groupId of groupIds) {
      const plan = await groups.planOf(organisationId, groupId);
      if (plan !== undefined && plan.connectionId === delta.connectionId && plan.sourceObject === delta.object) held.push({ groupId, plan });
    }
    if (held.length === 0) return 'absent';

    const mapped = new Map<string, PlanProperty>();
    for (const { plan } of held) for (const p of [...plan.properties, ...plan.predicateProperties]) mapped.set(p.identityId, p);
    const fields: Record<string, string> = {};
    const changed = new Map<string, unknown>();
    for (const p of mapped.values()) {
      if (!Object.hasOwn(delta.changed, p.fieldPath)) continue;
      const value = delta.changed[p.fieldPath];
      changed.set(p.identityId, value);
      fields[valueField(p.identityId, delta.connectionId)] = JSON.stringify({ v: value ?? null, at: delta.observedAt } satisfies HeldValue);
    }
    const sequence = delta.ordering === 'source_sequence' ? delta.sourceSeq : delta.observedAt;
    const guard = sequence === null ? undefined : { field: sequenceField(delta.connectionId), value: sequence };
    if (delta.operation !== 'delete' && changed.size === 0 && guard === undefined) return 'unchanged';
    const outcome = await state.applyLiveFields(liveObjectKeys, objectKey, guard, fields);
    if (outcome !== 'applied') return outcome;

    const current = await state.readHash(liveObjectKeys, objectKey);
    for (const { groupId, plan } of held) {
      if (delta.operation === 'delete') {
        if (current?.[leftField(groupId)] !== '1') {
          await state.applyLiveFields(liveObjectKeys, objectKey, undefined, { [leftField(groupId)]: '1' });
          groups.publish(organisationId, groupId, { type: 'membership', object: objectId, change: 'left' });
        }
        continue;
      }
      const changes: Change[] = plan.properties.filter((p) => changed.has(p.identityId)).map((p) => ({
        property: p.apiName, value: frameValue(changed.get(p.identityId)) as never, source: delta.connectionId, receivedAt: delta.observedAt,
      }));
      if (changes.length > 0) {
        const seq = await groups.nextSeq(organisationId, groupId);
        groups.publish(organisationId, groupId, { type: 'delta', seq, object: objectId, changes, coalesced } satisfies GroupFrame);
      }
      if (plan.predicate !== null && plan.predicateProperties.some((p) => changed.has(p.identityId)) && current !== undefined) {
        const subject = Object.fromEntries(plan.predicateProperties.map((p) =>
          [p.apiName, parseHeld(current[valueField(p.identityId, p.connectionId)])?.v ?? null]));
        const meets = testOf(plan.predicate.cel)(subject, new Date());
        const hadLeft = current[leftField(groupId)] === '1';
        if (!meets && !hadLeft) {
          await state.applyLiveFields(liveObjectKeys, objectKey, undefined, { [leftField(groupId)]: '1' });
          groups.publish(organisationId, groupId, { type: 'membership', object: objectId, change: 'left' });
        } else if (meets && hadLeft) {
          await state.applyLiveFields(liveObjectKeys, objectKey, undefined, { [leftField(groupId)]: '0' });
          groups.publish(organisationId, groupId, { type: 'membership', object: objectId, change: 'entered' });
        }
      }
    }
    return 'applied';
  }

  return {
    /** coalesced: how many other changes this one stands for, where its connection coalesces (18.4). */
    async apply(delta: SourceChange, coalesced = 0): Promise<ApplyOutcome> {
      const organisationId = delta.organisationId;
      const objectId = await state.read(liveMatchKeys, liveMatchKeys.key(organisationId, {
        connectionId: delta.connectionId, sourceKeyHash: sourceKeyHash(delta.object, delta.entityRef),
      }));
      if (objectId === undefined) {
        await state.addScored(livePendingKeys, livePendingKeys.key(organisationId, { connectionId: delta.connectionId, object: delta.object }),
          [{ member: JSON.stringify(delta), score: Date.parse(delta.observedAt) }]).catch(() => undefined);
        return 'pending';
      }
      return applyToObject(objectId, delta, coalesced);
    },

    /** After a backfill: the changes observed since its read began, applied over it (spec 18.5). */
    async drainPending(organisationId: string, connectionId: string, object: string, since: number): Promise<number> {
      const key = livePendingKeys.key(organisationId, { connectionId, object });
      let applied = 0;
      for (const text of await state.scoredMembers(livePendingKeys, key, since)) {
        let delta: SourceChange;
        try {
          delta = JSON.parse(text) as SourceChange;
        } catch {
          continue;
        }
        const objectId = await state.read(liveMatchKeys, liveMatchKeys.key(organisationId, {
          connectionId, sourceKeyHash: sourceKeyHash(delta.object, delta.entityRef),
        }));
        if (objectId !== undefined && await applyToObject(objectId, delta) === 'applied') applied += 1;
      }
      return applied;
    },
  };
}

export type DeltaApplier = ReturnType<typeof createDeltaApplier>;
