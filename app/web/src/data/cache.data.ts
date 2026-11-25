// The client's read cache: every read the pages make goes through it, keyed by route and input.
//
// - Concurrent reads of one key share one request.
// - A result is kept and shown at once when a page asks for it again, then read again in the
//   background once it is older than its freshness (stale-while-revalidate): reopening a page is
//   instant and never shows old data for long.
// - A read nobody watches any more is aborted, and its entry dropped a while later.
// - A write makes the reads it affects stale: by default every read under the same resource
//   path (POST /connect/connections/:id/rename makes GET /connect/connections... stale), plus any
//   route it names. Stale reads someone watches are read again at once; the rest when next asked.
// - Reads someone watches are read again when the window regains focus or the network returns.
//
// Pure TypeScript and an injected Api, so it is tested without a browser or React.

import { ApiError, routeInfo, type Api, type Input, type Output, type RouteName } from '../api/client.api.ts';

export type QueryStatus = 'loading' | 'success' | 'error';

/** What a page sees of one read. Immutable: a new object on every change. */
export interface Snapshot<T = unknown> {
  readonly status: QueryStatus;
  readonly data: T | undefined;
  readonly error: unknown;
  /** A request is in flight (the first read, or a refresh behind data already shown). */
  readonly fetching: boolean;
  /** When the data shown was read, epoch milliseconds; 0 before the first. */
  readonly updatedAt: number;
}

interface Entry {
  readonly key: string;
  readonly name: RouteName;
  readonly input: unknown;
  readonly path: string;
  snapshot: Snapshot;
  /** Made stale by a write or a refresh, whatever its age. */
  invalid: boolean;
  /** Made stale while a read was in flight: that read may predate the write, so read again after it. */
  again: boolean;
  inflight: Promise<unknown> | undefined;
  controller: AbortController | undefined;
  listeners: Set<() => void>;
  gc: ReturnType<typeof setTimeout> | undefined;
  /** The longest freshness any watcher asked for is not used: the shortest is, so no watcher sees older data than it asked. */
  staleMs: number;
}

export interface CacheOptions {
  /** How long a result is fresh by default, ms. */
  staleMs?: number;
  /** How long an unwatched entry is kept, ms. */
  keepMs?: number;
  now?: () => number;
}

const LOADING: Snapshot = Object.freeze({ status: 'loading', data: undefined, error: undefined, fetching: false, updatedAt: 0 });

/** JSON with object keys sorted, so equal inputs make equal keys whatever order they were written in. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }) ?? 'undefined';
}

/** The resource a route acts on: its path up to the first parameter, at most four segments under /api/v1. */
export function resourceOf(path: string): string {
  const segments = path.replace(/^\/api\/v1\//, '').split('/');
  const fixed: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':') || fixed.length === 4) break;
    fixed.push(segment);
  }
  // A path whose only fixed part is its last segment (an action on a collection) is its collection.
  return `/api/v1/${fixed.slice(0, Math.max(1, fixed.length)).join('/')}`;
}

const sameResource = (readPath: string, writePath: string): boolean => {
  const root = resourceOf(writePath);
  return readPath === root || readPath.startsWith(`${root}/`);
};

export class QueryCache {
  readonly #api: Api;
  readonly #entries = new Map<string, Entry>();
  readonly #staleMs: number;
  readonly #keepMs: number;
  readonly #now: () => number;
  /** Bumped by clear(): a read that started before belongs to a session that has gone. */
  #generation = 0;

  constructor(api: Api, options: CacheOptions = {}) {
    this.#api = api;
    this.#staleMs = options.staleMs ?? 30_000;
    this.#keepMs = options.keepMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  key(name: RouteName, input: unknown): string {
    return `${name}:${stableKey(input ?? {})}`;
  }

  #entry(name: RouteName, input: unknown): Entry {
    const key = this.key(name, input);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = {
        key, name, input, path: routeInfo(name).path, snapshot: LOADING, invalid: false, again: false, inflight: undefined, controller: undefined,
        listeners: new Set(), gc: undefined, staleMs: this.#staleMs,
      };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #set(entry: Entry, changes: Partial<Snapshot>): void {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...changes });
    for (const listener of [...entry.listeners]) listener();
  }

  /** What a read shows now. The same object until it changes. */
  snapshot<N extends RouteName>(name: N, input: Input<N>): Snapshot<Output<N>> {
    return (this.#entries.get(this.key(name, input))?.snapshot ?? LOADING) as Snapshot<Output<N>>;
  }

  /** Watches a read: the listener hears every change. The read is not started; see ensure. */
  subscribe(name: RouteName, input: unknown, listener: () => void, staleMs?: number): () => void {
    const entry = this.#entry(name, input);
    if (entry.gc !== undefined) {
      clearTimeout(entry.gc);
      entry.gc = undefined;
    }
    if (staleMs !== undefined) entry.staleMs = Math.min(entry.staleMs, staleMs);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0) return;
      // Nobody wants the answer: stop asking, and forget it after a while.
      if (entry.inflight !== undefined && entry.snapshot.status === 'loading') entry.controller?.abort();
      entry.gc = setTimeout(() => {
        if (entry.listeners.size === 0 && this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
      }, this.#keepMs);
    };
  }

  #stale(entry: Entry): boolean {
    return entry.invalid || entry.snapshot.status !== 'success' || this.#now() - entry.snapshot.updatedAt >= entry.staleMs;
  }

  /** Reads now unless a fresh answer is held or a read is in flight. */
  ensure(name: RouteName, input: unknown): void {
    const entry = this.#entry(name, input);
    if (entry.inflight === undefined && this.#stale(entry)) void this.#read(entry).catch(() => undefined);
  }

  /** Reads now, sharing a read already in flight. Rejects with the read's failure. */
  fetch<N extends RouteName>(name: N, input: Input<N>): Promise<Output<N>> {
    const entry = this.#entry(name, input);
    return (entry.inflight ?? this.#read(entry)) as Promise<Output<N>>;
  }

  /** The answer held if fresh, else reads it: for code outside a component (a prefetch, a resolver). */
  async get<N extends RouteName>(name: N, input: Input<N>): Promise<Output<N>> {
    const entry = this.#entry(name, input);
    if (!this.#stale(entry)) return entry.snapshot.data as Output<N>;
    return this.fetch(name, input);
  }

  #read(entry: Entry): Promise<unknown> {
    const generation = this.#generation;
    const controller = new AbortController();
    entry.controller = controller;
    this.#set(entry, { fetching: true });
    const promise = this.#api.call(entry.name, entry.input as never, { signal: controller.signal }).then(
      (data) => {
        if (generation !== this.#generation || entry.inflight !== promise) return data;
        entry.inflight = undefined;
        entry.controller = undefined;
        if (entry.again && entry.listeners.size > 0) {
          // Show what came back, then ask again for what the write changed.
          entry.again = false;
          this.#set(entry, { status: 'success', data, error: undefined, updatedAt: this.#now() });
          void this.#read(entry).catch(() => undefined);
          return data;
        }
        entry.again = false;
        entry.invalid = false;
        this.#set(entry, { status: 'success', data, error: undefined, fetching: false, updatedAt: this.#now() });
        return data;
      },
      (error: unknown) => {
        if (generation !== this.#generation || entry.inflight !== promise) throw error;
        entry.inflight = undefined;
        entry.controller = undefined;
        if (controller.signal.aborted && !(error instanceof ApiError)) {
          // Abandoned because nobody watched: as it was before the read.
          this.#set(entry, { fetching: false });
          throw error;
        }
        // A refresh that fails keeps the data shown, with the failure beside it.
        this.#set(entry, entry.snapshot.status === 'success'
          ? { error, fetching: false }
          : { status: 'error', error, fetching: false });
        throw error;
      },
    );
    entry.inflight = promise;
    return promise;
  }

  /** Sets a read's answer directly: the reply of a write that returns the new state. */
  set<N extends RouteName>(name: N, input: Input<N>, data: Output<N>): void {
    const entry = this.#entry(name, input);
    entry.invalid = false;
    this.#set(entry, { status: 'success', data, error: undefined, updatedAt: this.#now() });
  }

  /** Makes matching reads stale; those watched are read again now. */
  invalidate(match: (name: RouteName, input: unknown, path: string) => boolean): void {
    for (const entry of this.#entries.values()) {
      if (!match(entry.name, entry.input, entry.path)) continue;
      entry.invalid = true;
      if (entry.inflight !== undefined) entry.again = true;
      else if (entry.listeners.size > 0) void this.#read(entry).catch(() => undefined);
    }
  }

  /** Reads one key again now if watched, else when next asked. */
  refresh(name: RouteName, input: unknown): void {
    const key = this.key(name, input);
    this.invalidate((n, i) => n === name && this.key(n, i) === key);
  }

  /** After a write through this route: its resource's reads, and any it names. */
  invalidateAfter(write: RouteName, also: readonly RouteName[] = []): void {
    const path = routeInfo(write).path;
    const named = new Set(also);
    this.invalidate((name, _input, readPath) => named.has(name) || (routeInfo(name).method === 'GET' && sameResource(readPath, path)));
  }

  /** Reads someone watches again, if stale: on focus, or when the network returns. */
  refreshWatched(): void {
    for (const entry of this.#entries.values()) {
      if (entry.listeners.size > 0 && entry.inflight === undefined && this.#stale(entry)) void this.#read(entry).catch(() => undefined);
    }
  }

  /** Forgets everything: the session ended or the organisation changed. In-flight reads are abandoned. */
  clear(): void {
    this.#generation += 1;
    for (const entry of [...this.#entries.values()]) {
      entry.controller?.abort();
      entry.controller = undefined;
      entry.inflight = undefined;
      entry.again = false;
      entry.invalid = true;
      if (entry.listeners.size === 0) {
        if (entry.gc !== undefined) clearTimeout(entry.gc);
        this.#entries.delete(entry.key);
      } else {
        // Still watched: shown as loading, read again only when asked.
        this.#set(entry, LOADING);
      }
    }
  }

  /** For tests and diagnostics. */
  get size(): number {
    return this.#entries.size;
  }
}
