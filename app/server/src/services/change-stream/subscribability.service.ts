// Which streamed objects are subscribable, and which an admin lets be polled instead
// (decision 2026-11-15).
//
// Subscribable: the object passed the change-stream class on the connection's current
// manifest version (contracts/conformance/changeStreamClass.contract.ts): its stream is live.
// Not subscribable, with a polling fallback an admin enabled (connect.stream_polling_fallbacks):
// polled with a watermark every N minutes, and shown as "Not live, refreshed every N minutes"
// with its staleness, never as live. Neither: unavailable to live viewers and to Crons with
// change conditions; on-demand queries and scheduled Crons need no stream.
//
// Read by change-stream (its status, the poller's interval) and by the scheduler (a change
// condition needs a subscribable stream). Call inside a transaction with the organisation's context.

import { streamGateOf, testsObject, type StreamTest } from '../../contracts/conformance/changeStreamClass.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import { conformanceRunRepo, streamPollingFallbackRepo } from '../../repos/connect/index.repo.ts';

export type StreamMode = 'live' | 'polled' | 'unavailable';

export interface ObjectSubscribability {
  subscribable: boolean;
  /** The change_stream run read; null when none tested the object on this version. */
  runId: string | null;
  failed: StreamTest[];
  fallback: { intervalSeconds: number; enabledAt: string } | null;
  mode: StreamMode;
}

/** Recent change_stream runs read per connection: enough to find the latest for each object. */
const RUNS_READ = 50;

export async function subscribabilityOf(db: Queryable, connection: { id: string; manifestId: string }, objects: readonly string[])
  : Promise<Map<string, ObjectSubscribability>> {
  const runs = await conformanceRunRepo.changeStreamRuns(db, connection.id, connection.manifestId, RUNS_READ);
  const fallbacks = new Map((await streamPollingFallbackRepo.activeFor(db, connection.id)).map((f) => [f.object, f]));
  return new Map(objects.map((object) => {
    const gate = streamGateOf(runs.find((r) => testsObject(r, object)), object);
    const row = fallbacks.get(object);
    const fallback = row === undefined ? null : { intervalSeconds: row.intervalSeconds, enabledAt: row.enabledAt };
    const mode: StreamMode = gate.subscribable ? 'live' : fallback !== null ? 'polled' : 'unavailable';
    return [object, { ...gate, fallback, mode }];
  }));
}
