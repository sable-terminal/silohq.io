// What stream probes have seen (contracts/change-stream/probe.contract.ts; decision
// 2026-11-15), in redis-state with a 15-minute life. A probe watches one test record: every
// change published for it, by any path (a webhook delivery, the poller, the probe's own
// reads), is noted with its operation, source sequence, whether it was a duplicate, its
// de-duplication key's hash, and a digest of the probed fields. The record is named by the
// SHA-256 of its identifier. No value is kept.
//
// Noting reads the probe and writes it back: two deliveries for the same record at the same
// instant could lose one note. A conformance run edits its record one change at a time.

import { createHash } from 'node:crypto';
import type { SourceChange } from '../../contracts/change-stream/delta.contract.ts';
import { probeDigest } from '../../contracts/change-stream/probe.contract.ts';
import { changeProbeIndexKeys, changeProbeKeys } from '../../infra/keyspaces.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';

export const PROBE_TTL_SECONDS = 15 * 60;
const MAX_OBSERVATIONS = 200;

/** One change as published, for a probe to note. */
export interface PublishNote {
  delta: SourceChange;
  duplicate: boolean;
  /** The truncated SHA-256 of its de-duplication key; null where it had none (never dropped as a repeat). */
  dedupHash: string | null;
}

export const entityHashOf = (entityRef: string): string => createHash('sha256').update(entityRef, 'utf8').digest('hex');

export const probeKey = (organisationId: string, probeId: string) => changeProbeKeys.key(organisationId, { probeId });

/** Notes each change to the probes watching its record. */
export async function noteProbes(state: RedisStore, organisationId: string, connectionId: string, notes: readonly PublishNote[]): Promise<void> {
  if (notes.length === 0) return;
  const indexKey = changeProbeIndexKeys.key(organisationId, { connectionId });
  await state.removeScoredUpTo(changeProbeIndexKeys, indexKey, Date.now());
  for (const probeId of await state.scoredMembers(changeProbeIndexKeys, indexKey)) {
    const key = probeKey(organisationId, probeId);
    const probe = await state.read(changeProbeKeys, key);
    if (probe === undefined || probe.entityHash === null) continue;
    const mine = notes.filter((n) => n.delta.object === probe.object && entityHashOf(n.delta.entityRef) === probe.entityHash);
    if (mine.length === 0) continue;
    const observations = [...probe.observations, ...mine.map((n) => ({
      operation: n.delta.operation, sourceSeq: n.delta.sourceSeq, digest: probeDigest(n.delta.changed, probe.fields),
      duplicate: n.duplicate, dedupHash: n.dedupHash,
    }))].slice(-MAX_OBSERVATIONS);
    await state.put(changeProbeKeys, key, { ...probe, observations }, { ttlSeconds: PROBE_TTL_SECONDS });
  }
}
