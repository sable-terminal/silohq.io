// A source's health as a clone shows it (spec 18.7, 30.3 source_status): healthy, lagging
// (with the lag), stale (with the age and why) or down (why), from change-stream's record.
// A source with no record has no stream delivering, so it is stale, never live. A source an
// admin lets be polled because its stream is not subscribable is not live: it says so, how
// often it is refreshed, and how long since it last was (decision 2026-11-15), unless it is
// worse (stale or down).

import type { GroupFrame } from '../../contracts/gateway/live.contract.ts';
import { changeStatusKeys, changeWatermarkKeys } from '../../infra/keyspaces.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';

export type SourceStatus = Extract<GroupFrame, { type: 'source_status' }>['sources'][number];

/** "Not live, refreshed every N minutes" (pure). */
export const notLiveReason = (refreshEverySeconds: number): string => {
  const minutes = Math.round(refreshEverySeconds / 60);
  return `Not live, refreshed every ${minutes} minute${minutes === 1 ? '' : 's'}`;
};

export async function sourceStatusOf(state: RedisStore, organisationId: string, connectionId: string, now: number = Date.now(),
  polled?: { sourceObject: string; refreshEverySeconds: number }): Promise<SourceStatus> {
  const record = await state.readHash(changeStatusKeys, changeStatusKeys.key(organisationId, { connectionId }));
  if (polled !== undefined && record?.status !== 'stale' && record?.status !== 'stopped') {
    const mark = await state.read(changeWatermarkKeys, changeWatermarkKeys.key(organisationId, { connectionId, object: polled.sourceObject }));
    const refreshed = mark?.polledAt ?? record?.lastDeltaAt ?? record?.since;
    return {
      source: connectionId, status: 'not_live', refreshEverySeconds: polled.refreshEverySeconds, reason: notLiveReason(polled.refreshEverySeconds),
      ...(refreshed === undefined ? {} : { ageMs: Math.max(0, now - Date.parse(refreshed)) }),
    };
  }
  if (record === undefined) return { source: connectionId, status: 'stale', reason: 'no change stream is delivering for this source' };
  const reason = record.reason === undefined ? {} : { reason: record.reason };
  switch (record.status) {
    case 'live':
      return { source: connectionId, status: 'healthy' };
    case 'delayed':
      return {
        source: connectionId, status: 'lagging', ...reason,
        ...(record.lastDeliveryAt === undefined ? {} : { lagMs: Math.max(0, now - Date.parse(record.lastDeliveryAt)) }),
      };
    case 'stale':
      return { source: connectionId, status: 'stale', ageMs: Math.max(0, now - Date.parse(record.lastDeltaAt ?? record.since)), ...reason };
    default:
      return { source: connectionId, status: 'down', ...reason };
  }
}
