// Concurrency bounds (spec 7.8): model calls in flight per organisation and per cell,
// counted in redis-data so every gateway replica sees the same numbers.
//
// A slot is a lease: the call id in a sorted set, scored by when the lease ends. Taking
// one adds the call, then counts the live leases; over the bound, it withdraws and is
// refused. Two callers racing for the last slot may both be refused, never both admitted,
// so the bound holds. A replica that dies mid-call leaves a lease that expires on its own.

import { modelCallSlotKeys, modelCellSlotKeys } from '../../infra/keyspaces.infra.ts';
import type { Keyspace, RedisKey, RedisStore } from '../../infra/redis.infra.ts';

export interface Slot {
  release(): Promise<void>;
}

export type SlotBound = 'model_organisation_concurrency' | 'model_cell_concurrency';

export interface SlotRefusal {
  bound: SlotBound;
  limit: number;
}

export interface Slots {
  acquire(organisationId: string, callId: string, leaseMs: number): Promise<Slot | SlotRefusal>;
}

export interface SlotOptions {
  cellId: string;
  perOrganisation: number;
  perCell: number;
}

export function createSlots(store: RedisStore, options: SlotOptions): Slots {
  const cellKey = modelCellSlotKeys.key({ cellId: options.cellId });

  const take = async <P extends string>(keyspace: Keyspace<P, 'zset'>, key: RedisKey<P>, callId: string, limit: number, leaseMs: number)
    : Promise<boolean> => {
    const now = Date.now();
    await store.removeScoredUpTo(keyspace, key, now);
    await store.addScored(keyspace, key, [{ member: callId, score: now + leaseMs }]);
    if (await store.countScored(keyspace, key, now, Number.POSITIVE_INFINITY) <= limit) return true;
    await give(keyspace, key, callId);
    return false;
  };

  // Released: scored at zero, so it no longer counts, and swept at once.
  const give = async <P extends string>(keyspace: Keyspace<P, 'zset'>, key: RedisKey<P>, callId: string): Promise<void> => {
    await store.addScored(keyspace, key, [{ member: callId, score: 0 }]);
    await store.removeScoredUpTo(keyspace, key, 0);
  };

  return {
    async acquire(organisationId, callId, leaseMs) {
      const orgKey = modelCallSlotKeys.key(organisationId);
      if (!await take(modelCallSlotKeys, orgKey, callId, options.perOrganisation, leaseMs)) {
        return { bound: 'model_organisation_concurrency', limit: options.perOrganisation };
      }
      let cell = false;
      try {
        cell = await take(modelCellSlotKeys, cellKey, callId, options.perCell, leaseMs);
      } finally {
        if (!cell) await give(modelCallSlotKeys, orgKey, callId);
      }
      if (!cell) return { bound: 'model_cell_concurrency', limit: options.perCell };
      return {
        async release() {
          await Promise.all([give(modelCellSlotKeys, cellKey, callId), give(modelCallSlotKeys, orgKey, callId)]);
        },
      };
    },
  };
}
