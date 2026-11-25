// One client subscription's outbound pipeline (spec 30.3, 30.4): group frames in, client
// frames out.
//
// - Projection: only the fields granted to the subscriber leave the gateway. Groups are
//   already per permission fingerprint; this is the last check, and the one that applies
//   a projection_changed at once, removing withheld fields from deltas still waiting.
// - Coalescing: within a window (250 ms), the latest value per object and property, sent
//   as one delta with the count coalesced. A visual state transition is never coalesced
//   away: a delta whose state differs from the state already waiting for that object
//   sends the window first, so normal, failed, normal sends both transitions.
// - Back-pressure: above the high-water mark of unacknowledged deltas (1,000 frames, or
//   the client's smaller buffer capacity, or 4 MB) the subscription enters snapshot mode:
//   the latest state of each changed object every 2 seconds, until the client has
//   acknowledged down to half the mark. The client is told each way (buffer_mode). A
//   client that stops acknowledging altogether, ten times past the mark, is stalled.
// - Until the state plane has answered the subscribe, frames (its snapshot) wait,
//   bounded; if too many arrive the client is told to resynchronise instead.
//
// Values pass through memory only (spec 30.7): nothing here is logged or kept.

import { LIMITS } from '../../config/limits.config.ts';
import type { DeltaFrame, GroupFrame, ServerFrame } from '../../contracts/gateway/live.contract.ts';

export interface Timers {
  setTimeout(work: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: Timers = {
  setTimeout: (work, ms) => setTimeout(work, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LiveSubscriberOptions {
  subscriptionId: string;
  /** Sends a frame to the client; the bytes sent, or 0 when it was not sent. */
  send(frame: ServerFrame): number;
  /** The client stopped acknowledging. */
  onStalled(): void;
  bufferCapacity?: number | undefined;
  timers?: Timers;
  coalesceMs?: number;
  snapshotIntervalMs?: number;
  /** The subscriber entered snapshot mode or left it (spec 30.4); the state plane audits entering it. */
  onModeChange?: (mode: 'snapshot' | 'live') => void;
}

export interface LiveSubscriber {
  readonly subscriptionId: string;
  readonly mode: 'live' | 'snapshot';
  readonly ackedSeq: number | undefined;
  readonly unacknowledged: { frames: number; bytes: number };
  /** The state plane accepted the subscription: frames flow from now. */
  activate(granted: readonly string[]): void;
  deliver(frame: GroupFrame): void;
  ack(seq: number): void;
  close(): void;
}

const EARLY_FRAMES = 1_000;

function merge(into: DeltaFrame, next: DeltaFrame): DeltaFrame {
  const changes = new Map(into.changes.map((c) => [c.property, c]));
  for (const c of next.changes) changes.set(c.property, c);
  const state = next.state ?? into.state;
  return {
    type: 'delta', seq: Math.max(into.seq, next.seq), object: into.object, changes: [...changes.values()],
    ...(state === undefined ? {} : { state }), coalesced: into.coalesced + 1 + next.coalesced,
  };
}

export function createLiveSubscriber(options: LiveSubscriberOptions): LiveSubscriber {
  const sub = options.subscriptionId;
  const timers = options.timers ?? systemTimers;
  const coalesceMs = options.coalesceMs ?? LIMITS.statePlane.coalesceMs;
  const snapshotIntervalMs = options.snapshotIntervalMs ?? LIMITS.statePlane.snapshotModeIntervalMs;
  const frameMark = Math.min(options.bufferCapacity ?? LIMITS.statePlane.clientBufferDeltas, LIMITS.statePlane.clientBufferDeltas);
  const byteMark = LIMITS.statePlane.clientBufferBytes;

  let active = false;
  let closed = false;
  let early: GroupFrame[] = [];
  let earlyOverflow = false;
  let granted = new Set<string>();
  let mode: 'live' | 'snapshot' = 'live';
  // The coalescing window in live mode; the changed objects in snapshot mode.
  const waiting = new Map<string, DeltaFrame>();
  let windowTimer: unknown;
  let snapshotTimer: unknown;
  // Deltas sent and not yet acknowledged, in sequence order.
  let sent: { seq: number; bytes: number }[] = [];
  let head = 0;
  let unackedBytes = 0;
  let ackedSeq: number | undefined;

  const unackedFrames = (): number => sent.length - head;
  const inSnapshot = (): boolean => mode === 'snapshot';

  const project = (delta: DeltaFrame): DeltaFrame | undefined => {
    const changes = delta.changes.filter((c) => granted.has(c.property));
    if (changes.length === 0) return undefined;
    return changes.length === delta.changes.length ? delta : { ...delta, changes };
  };

  const emit = (delta: DeltaFrame): void => {
    const bytes = options.send({ ...delta, sub });
    if (bytes === 0) return;
    sent.push({ seq: delta.seq, bytes });
    unackedBytes += bytes;
    if (unackedFrames() > frameMark * 10) {
      options.onStalled();
      return;
    }
    if (mode === 'live' && (unackedFrames() > frameMark || unackedBytes > byteMark)) enterSnapshot();
  };

  const absorb = (delta: DeltaFrame): void => {
    const current = waiting.get(delta.object);
    waiting.set(delta.object, current === undefined ? delta : merge(current, delta));
  };

  const drain = (): DeltaFrame[] => {
    const ordered = [...waiting.values()].sort((a, b) => a.seq - b.seq);
    waiting.clear();
    return ordered;
  };

  const flushWindow = (): void => {
    if (windowTimer !== undefined) timers.clearTimeout(windowTimer);
    windowTimer = undefined;
    for (const delta of drain()) {
      if (closed) return;
      if (mode === 'snapshot') absorb(delta);
      else emit(delta);
    }
  };

  const snapshotTick = (): void => {
    snapshotTimer = undefined;
    if (closed || mode !== 'snapshot') return;
    for (const delta of drain()) {
      if (closed) return;
      emit(delta);
    }
    if (!closed && mode === 'snapshot') snapshotTimer = timers.setTimeout(snapshotTick, snapshotIntervalMs);
  };

  function enterSnapshot(): void {
    mode = 'snapshot';
    if (windowTimer !== undefined) timers.clearTimeout(windowTimer);
    windowTimer = undefined;
    options.send({ type: 'buffer_mode', sub, mode: 'snapshot' });
    options.onModeChange?.('snapshot');
    snapshotTimer = timers.setTimeout(snapshotTick, snapshotIntervalMs);
  }

  const leaveSnapshot = (): void => {
    mode = 'live';
    if (snapshotTimer !== undefined) timers.clearTimeout(snapshotTimer);
    snapshotTimer = undefined;
    options.send({ type: 'buffer_mode', sub, mode: 'live' });
    options.onModeChange?.('live');
    for (const delta of drain()) emit(delta);
  };

  const deliverDelta = (delta: DeltaFrame): void => {
    const projected = project(delta);
    if (projected === undefined) return;
    if (mode === 'snapshot') {
      absorb(projected);
      return;
    }
    if (coalesceMs === 0) {
      emit(projected);
      return;
    }
    const current = waiting.get(projected.object);
    if (current?.state !== undefined && projected.state !== undefined && current.state.value !== projected.state.value) {
      flushWindow();
      // Sending the window may have crossed the high-water mark.
      if (inSnapshot()) {
        absorb(projected);
        return;
      }
      waiting.set(projected.object, projected);
    } else {
      waiting.set(projected.object, current === undefined ? projected : merge(current, projected));
    }
    windowTimer ??= timers.setTimeout(flushWindow, coalesceMs);
  };

  const deliverNow = (frame: GroupFrame): void => {
    switch (frame.type) {
      case 'delta':
        deliverDelta(frame);
        return;
      case 'projection_changed': {
        granted = new Set(frame.granted);
        for (const [object, delta] of waiting) {
          const projected = project(delta);
          if (projected === undefined) waiting.delete(object);
          else waiting.set(object, projected);
        }
        options.send({ ...frame, sub });
        return;
      }
      case 'snapshot': {
        if (mode === 'live') flushWindow();
        const objects = frame.objects.map((o) => ({ ...o, values: o.values.filter((v) => granted.has(v.property)) }));
        options.send({ ...frame, objects, sub });
        return;
      }
      default:
        if (mode === 'live') flushWindow();
        options.send({ ...frame, sub });
    }
  };

  return {
    subscriptionId: sub,
    get mode() {
      return mode;
    },
    get ackedSeq() {
      return ackedSeq;
    },
    get unacknowledged() {
      return { frames: unackedFrames(), bytes: unackedBytes };
    },
    activate(fields) {
      if (active || closed) return;
      active = true;
      granted = new Set(fields);
      const held = early;
      early = [];
      if (earlyOverflow) {
        options.send({ type: 'resync_required', sub });
        return;
      }
      for (const frame of held) deliverNow(frame);
    },
    deliver(frame) {
      if (closed) return;
      if (!active) {
        if (early.length < EARLY_FRAMES) early.push(frame);
        else earlyOverflow = true;
        return;
      }
      deliverNow(frame);
    },
    ack(seq) {
      if (closed) return;
      ackedSeq = Math.max(ackedSeq ?? seq, seq);
      while (head < sent.length && sent[head]!.seq <= seq) {
        unackedBytes -= sent[head]!.bytes;
        head += 1;
      }
      if (head > 1_024 && head * 2 > sent.length) {
        sent = sent.slice(head);
        head = 0;
      }
      if (mode === 'snapshot' && unackedFrames() <= frameMark / 2 && unackedBytes <= byteMark / 2) leaveSnapshot();
    },
    close() {
      closed = true;
      if (windowTimer !== undefined) timers.clearTimeout(windowTimer);
      if (snapshotTimer !== undefined) timers.clearTimeout(snapshotTimer);
      waiting.clear();
      early = [];
    },
  };
}
