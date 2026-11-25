// Per-connection coalescing (spec 18.4): above a connection's rate (1,000 changes a second, a
// target) the state plane stops applying each change as it comes and, for that connection,
// keeps the latest value of each record's properties for a second, then applies one change
// per record, marked with how many it stands for (the delta frame's coalesced count, which
// the clone states). The connection goes back to change by change once a second passes under
// the rate. Entering coalescing is recorded once per episode (stream_coalesced).
//
// Per replica: changes reach a replica through a NATS queue group, so each replica counts and
// coalesces what it receives. Ordering within a record follows the manifest's ordering (source
// sequence or observation time); the guard on apply still refuses a change older than the one
// applied.

import type { SourceChange } from '../../contracts/change-stream/delta.contract.ts';

export interface CoalescerOptions {
  /** Changes a second, per connection, above which it coalesces. */
  abovePerSecond: number;
  /** Applies a change; coalesced is how many others it stands for. */
  apply(delta: SourceChange, coalesced: number): Promise<unknown>;
  /** A connection began coalescing: the rate it reached in its window. */
  onCoalescing(delta: SourceChange, rate: number): Promise<void>;
  onError(error: unknown, delta: SourceChange): void;
  now?: () => number;
}

const WINDOW_MS = 1_000;

/** Whether a's place in its record's order is after b's (18.6). */
function later(a: SourceChange, b: SourceChange): boolean {
  if (a.ordering === 'source_sequence' && a.sourceSeq !== null && b.sourceSeq !== null) {
    const [x, y] = [a.sourceSeq, b.sourceSeq];
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return BigInt(x) > BigInt(y);
    return x > y;
  }
  return a.observedAt > b.observedAt;
}

/**
 * A record's changes in a window as one: in order, each property its latest value; a deletion
 * wins unless the record changed again after it, when it is the change since the deletion.
 */
export function merged(changes: readonly SourceChange[]): SourceChange {
  const ordered = [...changes].sort((a, b) => (later(a, b) ? 1 : later(b, a) ? -1 : 0));
  const last = ordered.at(-1)!;
  const sinceDelete = ordered.slice(ordered.findLastIndex((c) => c.operation === 'delete') + 1);
  if (last.operation === 'delete') return last;
  const changed: Record<string, unknown> = {};
  for (const c of sinceDelete) Object.assign(changed, c.changed);
  return { ...last, changed: changed as SourceChange['changed'] };
}

export function createCoalescer(options: CoalescerOptions) {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  /** Coalescing connections: per record, its changes in the current second. */
  const coalescing = new Map<string, { buffer: Map<string, SourceChange[]>; received: number }>();
  const keyOf = (d: SourceChange) => `${d.organisationId}\u0000${d.connectionId}`;
  const recordOf = (d: SourceChange) => `${d.object}\u0000${d.entityRef}`;
  const hold = (into: Map<string, SourceChange[]>, d: SourceChange) => into.set(recordOf(d), [...(into.get(recordOf(d)) ?? []), d]);

  return {
    /** A change arrives: applied at once, or held while its connection coalesces. */
    async push(delta: SourceChange): Promise<void> {
      const key = keyOf(delta);
      const at = now();
      let window = windows.get(key);
      if (window === undefined || at - window.start >= WINDOW_MS) {
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      const held = coalescing.get(key);
      if (held !== undefined) {
        held.received += 1;
        hold(held.buffer, delta);
        return;
      }
      if (window.count > options.abovePerSecond) {
        const entered = { buffer: new Map<string, SourceChange[]>(), received: 1 };
        hold(entered.buffer, delta);
        coalescing.set(key, entered);
        await options.onCoalescing(delta, window.count).catch((error: unknown) => options.onError(error, delta));
        return;
      }
      await options.apply(delta, 0);
    },

    /** Each second: one change per record of each coalescing connection; a connection back under its rate goes live again. */
    async flush(): Promise<void> {
      for (const [key, held] of [...coalescing]) {
        const { buffer, received } = held;
        coalescing.set(key, { buffer: new Map(), received: 0 });
        for (const changes of buffer.values()) {
          const one = merged(changes);
          try {
            await options.apply(one, changes.length - 1);
          } catch (error) {
            options.onError(error, one);
          }
        }
        if (received <= options.abovePerSecond) coalescing.delete(key);
      }
      for (const [key, window] of windows) if (now() - window.start >= 10 * WINDOW_MS) windows.delete(key);
    },

    /** Whether a connection is coalescing now. */
    coalescing(organisationId: string, connectionId: string): boolean {
      return coalescing.has(`${organisationId}\u0000${connectionId}`);
    },
  };
}

export type Coalescer = ReturnType<typeof createCoalescer>;
