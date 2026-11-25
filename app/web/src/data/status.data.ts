// What the whole client must show about its connection to the cell, whatever page is open:
// whether the session has ended, the organisation's writes are paused (a cell migration's
// window, spec 6.4), the cell is shedding load (spec 12.4), or the network is gone. Fed by the
// API client's signals; read by the shell's banners and by every control that writes, which is
// disabled while writes are paused rather than failing when pressed.

import type { ApiSignals } from '../api/client.api.ts';

export interface ClientStatus {
  readonly session: 'live' | 'ended' | 'mfa';
  readonly paused: boolean;
  readonly offline: boolean;
  /** Epoch ms until which the cell asked to be left alone; undefined when it is not shedding. */
  readonly overloadedUntil: number | undefined;
}

export interface StatusStore {
  get(): ClientStatus;
  subscribe(listener: () => void): () => void;
  /** The organisation's writes are paused (the shell read a migration's read-only window). */
  pause(): void;
  /** The pause has ended (the shell read the migration's state, or a write went through). */
  resume(): void;
  /** A session was established again (signed in in this tab). */
  live(): void;
}

const INITIAL: ClientStatus = Object.freeze({ session: 'live', paused: false, offline: false, overloadedUntil: undefined });

export function createStatusStore(signals: ApiSignals, now: () => number = Date.now): StatusStore {
  let status = INITIAL;
  let clearing: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (changes: Partial<ClientStatus>) => {
    const next = { ...status, ...changes };
    if ((Object.keys(changes) as (keyof ClientStatus)[]).every((k) => next[k] === status[k])) return;
    status = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };
  signals.subscribe((signal) => {
    switch (signal.type) {
      case 'unauthenticated': set({ session: 'ended' }); break;
      case 'authenticated': set({ session: 'live' }); break;
      case 'mfa': set({ session: 'mfa' }); break;
      case 'paused': set({ paused: true }); break;
      case 'overloaded': {
        const until = now() + (signal.retryAfterSeconds ?? 30) * 1000;
        set({ overloadedUntil: Math.max(until, status.overloadedUntil ?? 0) });
        if (clearing !== undefined) clearTimeout(clearing);
        clearing = setTimeout(() => {
          clearing = undefined;
          set({ overloadedUntil: undefined });
        }, Math.max(0, (status.overloadedUntil ?? 0) - now()));
        break;
      }
      case 'offline': set({ offline: true }); break;
      case 'reachable': set({ offline: false }); break;
    }
  });
  return {
    get: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pause: () => set({ paused: true }),
    resume: () => set({ paused: false }),
    live: () => set({ session: 'live' }),
  };
}
