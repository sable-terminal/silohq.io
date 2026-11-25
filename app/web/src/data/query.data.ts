'use client';

// The hooks every page reads and writes through.
//
//   const types = useQuery('listObjectTypes', { query: { limit: 100 } });
//   const rename = useMutation('renameConnection');
//   const result = await rename.run({ params: { connectionId }, body: { name } });
//
// A read returns what the cache holds at once and refreshes it as the cache decides
// (cache.data.ts). A write refreshes the reads it affects, reuses its idempotency key when the
// same intent is tried again after a failure (a keyed write then applies once), never runs twice
// at once from one control, and says before it is tried why it would be refused: the
// organisation's writes are paused, or the person does not hold the permission it needs.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, isApiError, permissionOf, routeInfo, type Api, type CallOptions, type Input, type Output, type RouteName } from '../api/client.api.ts';
import { QueryCache, stableKey, type Snapshot } from './cache.data.ts';
import { createStatusStore, type ClientStatus, type StatusStore } from './status.data.ts';

export interface DataLayer {
  readonly api: Api;
  readonly cache: QueryCache;
  readonly status: StatusStore;
}

export function createDataLayer(client: Api = api): DataLayer {
  return { api: client, cache: new QueryCache(client), status: createStatusStore(client.signals) };
}

/** The browser's one data layer; a test or a story may provide its own. */
export const browserData: DataLayer = createDataLayer();

const DataContext = createContext<DataLayer>(browserData);
export const DataProvider = DataContext.Provider;
export const useData = (): DataLayer => useContext(DataContext);

let watching = false;
/** Reads someone watches are refreshed when the window comes back into view or the network returns. */
function watchWindow(cache: QueryCache): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const refresh = () => {
    if (document.visibilityState === 'visible') cache.refreshWatched();
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
}

export interface QueryOptions {
  /** How long an answer is fresh, ms (default 30 s). */
  staleMs?: number;
  /** Read again this often while the page is visible, ms. */
  refreshMs?: number;
  /** While a new input loads, keep showing the last answer (paging, filtering). */
  keepPrevious?: boolean;
}

export interface QueryResult<T> {
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly data: T | undefined;
  readonly error: unknown;
  readonly fetching: boolean;
  readonly updatedAt: number;
  /** The data shown is the previous input's, while this one loads. */
  readonly previous: boolean;
  /** Reads again now. */
  refetch(): void;
}

const IDLE: Snapshot = Object.freeze({ status: 'loading', data: undefined, error: undefined, fetching: false, updatedAt: 0 });

/** A read. Pass null as the input to wait (a parameter not yet known): the result is idle. */
export function useQuery<N extends RouteName>(name: N, input: Input<N> | null, options: QueryOptions = {}): QueryResult<Output<N>> {
  const { cache } = useData();
  const key = input === null ? null : cache.key(name, input);
  const inputRef = useRef(input);
  inputRef.current = input;
  const { staleMs, refreshMs, keepPrevious } = options;

  const subscribe = useCallback((listener: () => void) => {
    if (key === null) return () => undefined;
    return cache.subscribe(name, inputRef.current, listener, staleMs);
  }, [cache, name, key, staleMs]);
  const getSnapshot = useCallback(() => (key === null ? IDLE : cache.snapshot(name, inputRef.current as Input<N>)), [cache, name, key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE) as Snapshot<Output<N>>;

  useEffect(() => {
    watchWindow(cache);
    if (key !== null) cache.ensure(name, inputRef.current);
  }, [cache, name, key]);

  useEffect(() => {
    if (key === null || refreshMs === undefined) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') cache.refresh(name, inputRef.current);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [cache, name, key, refreshMs]);

  const last = useRef<Snapshot<Output<N>> | undefined>(undefined);
  if (snapshot.status === 'success') last.current = snapshot;
  const showPrevious = keepPrevious === true && snapshot.status === 'loading' && last.current !== undefined;
  const shown = showPrevious ? last.current! : snapshot;

  const refetch = useCallback(() => {
    if (key !== null) cache.refresh(name, inputRef.current);
  }, [cache, name, key]);

  return {
    status: key === null ? 'idle' : shown.status,
    data: shown.data,
    error: snapshot.error,
    fetching: snapshot.fetching || (key !== null && snapshot.status === 'loading'),
    updatedAt: shown.updatedAt,
    previous: showPrevious,
    refetch,
  };
}

/** A list read a page at a time by cursor: every page so far, and the next on request. */
export interface PagesResult<T> {
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly pages: readonly T[];
  readonly error: unknown;
  readonly fetching: boolean;
  readonly hasMore: boolean;
  loadMore(): void;
  refetch(): void;
}

/**
 * Cursor paging: `inputFor(cursor)` is the read for one page (cursor undefined for the first),
 * `nextOf(page)` the cursor after it, or null at the end. A change of `deps` starts again.
 */
export function usePages<N extends RouteName>(name: N, inputFor: ((cursor: string | undefined) => Input<N>) | null,
  nextOf: (page: Output<N>) => string | null | undefined, deps: readonly unknown[]): PagesResult<Output<N>> {
  const { cache } = useData();
  const depsKey = stableKey(deps);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const inputForRef = useRef(inputFor);
  inputForRef.current = inputFor;
  useEffect(() => setCursors((c) => (c.length === 1 && c[0] === undefined ? c : [undefined])), [depsKey]);

  const inputs = useMemo(() => (inputForRef.current === null ? [] : cursors.map((c) => inputForRef.current!(c))),
    // The inputs follow the cursors and deps; inputFor is read through its ref.
    [cursors, depsKey, inputFor === null]);
  const keys = inputs.map((input) => cache.key(name, input)).join('\n');

  const subscribe = useCallback((listener: () => void) => {
    const stops = inputs.map((input) => cache.subscribe(name, input, listener));
    return () => stops.forEach((stop) => stop());
  }, [cache, name, keys]);
  const cached = useRef<{ keys: string; snaps: Snapshot[] }>({ keys: '', snaps: [] });
  const getSnapshot = useCallback(() => {
    const snaps = inputs.map((input) => cache.snapshot(name, input));
    const prev = cached.current;
    if (prev.keys === keys && prev.snaps.length === snaps.length && prev.snaps.every((s, i) => s === snaps[i])) return prev.snaps;
    cached.current = { keys, snaps };
    return snaps;
  }, [cache, name, keys]);
  const snaps = useSyncExternalStore(subscribe, getSnapshot, () => [] as Snapshot[]) as Snapshot<Output<N>>[];

  useEffect(() => {
    watchWindow(cache);
    for (const input of inputs) cache.ensure(name, input);
  }, [cache, name, keys]);

  const pages = snaps.filter((s) => s.data !== undefined).map((s) => s.data!);
  const lastSnap = snaps[snaps.length - 1];
  const lastPage = lastSnap?.data;
  const next = lastPage === undefined ? null : nextOf(lastPage) ?? null;
  const failed = snaps.find((s) => s.status === 'error');
  const status = inputFor === null ? 'idle' : failed !== undefined && pages.length === 0 ? 'error' : pages.length === 0 ? 'loading' : 'success';

  return {
    status,
    pages,
    error: failed?.error,
    fetching: snaps.some((s) => s.fetching || s.status === 'loading'),
    hasMore: next !== null && lastSnap?.status === 'success',
    loadMore: () => {
      if (next !== null && !cursors.includes(next)) setCursors((c) => [...c, next]);
    },
    refetch: () => {
      for (const input of inputs) cache.refresh(name, input);
    },
  };
}

/** The organisation-wide state controls react to. */
export function useClientStatus(): ClientStatus {
  const { status } = useData();
  return useSyncExternalStore(status.subscribe, status.get, status.get);
}

/** Why a control cannot be used now, said before it is pressed. */
export interface Blocked {
  readonly reason: 'paused' | 'permission';
  readonly message: string;
  /** For a permission: the one it needs. */
  readonly permission?: string;
}

const PERMISSIONS_FRESH_MS = 5 * 60_000;

/** Whether the person may call a route, before they try: undefined while not yet known. */
export function usePermit(name: RouteName): { allowed: boolean | undefined; blocked: Blocked | undefined } {
  const permission = permissionOf(name);
  const held = useQuery('readMyPermissions', permission === undefined ? null : {}, { staleMs: PERMISSIONS_FRESH_MS });
  if (permission === undefined) return { allowed: true, blocked: undefined };
  if (held.data === undefined) return { allowed: undefined, blocked: undefined };
  const entry = held.data.permissions.find((p) => p.id === permission);
  // A permission the catalogue does not know is the server's to refuse; never guessed here.
  if (entry === undefined || entry.held) return { allowed: true, blocked: undefined };
  return { allowed: false, blocked: { reason: 'permission', permission, message: `Needs ${permission}: ${entry.description}` } };
}

/** One read of the person's permissions, for a list of controls: why each route would be refused, if it would. */
export function usePermits(): (name: RouteName) => Blocked | undefined {
  const held = useQuery('readMyPermissions', {}, { staleMs: PERMISSIONS_FRESH_MS });
  const status = useClientStatus();
  return useMemo(() => {
    const index = new Map((held.data?.permissions ?? []).map((p) => [p.id, p]));
    return (name: RouteName) => {
      if (routeInfo(name).writes && status.paused) {
        return { reason: 'paused' as const, message: 'Changes are paused while your organisation moves to another Silo cell.' };
      }
      const permission = permissionOf(name);
      const entry = permission === undefined ? undefined : index.get(permission);
      if (permission === undefined || entry === undefined || entry.held) return undefined;
      return { reason: 'permission' as const, permission, message: `Needs ${permission}: ${entry.description}` };
    };
  }, [held.data, status.paused]);
}

/** Whether a write may be tried now: its permission, and the organisation's writes not paused. */
export function useBlocked(name: RouteName): Blocked | undefined {
  const permit = usePermit(name);
  const status = useClientStatus();
  if (routeInfo(name).writes && status.paused) {
    return { reason: 'paused', message: 'Changes are paused while your organisation moves to another Silo cell. Reading goes on.' };
  }
  return permit.blocked;
}

export type MutationResult<T> = { ok: true; data: T } | { ok: false; error: unknown };

export interface Mutation<N extends RouteName> {
  /** Runs the write. Never rejects: the outcome says how it went, and `error` holds a failure. */
  run(input: Input<N>, options?: Pick<CallOptions, 'timeoutMs'>): Promise<MutationResult<Output<N>>>;
  readonly pending: boolean;
  readonly error: unknown;
  readonly data: Output<N> | undefined;
  /** Why it cannot be tried now; a control shows it disabled with this message. */
  readonly blocked: Blocked | undefined;
  reset(): void;
}

export interface MutationOptions<N extends RouteName> {
  /** Reads beyond the route's own resource that the write changes. */
  invalidates?: readonly RouteName[];
  /** False: read nothing again afterwards (signing out, after which every read is forgotten). */
  refresh?: boolean;
  onSuccess?: (data: Output<N>, input: Input<N>) => void;
}

/** A write. */
export function useMutation<N extends RouteName>(name: N, options: MutationOptions<N> = {}): Mutation<N> {
  const data = useData();
  const blocked = useBlocked(name);
  const [state, setState] = useState<{ pending: boolean; error: unknown; data: Output<N> | undefined }>({ pending: false, error: undefined, data: undefined });
  const inflight = useRef<Promise<MutationResult<Output<N>>> | undefined>(undefined);
  /** The last failed intent: tried again unchanged, it keeps its idempotency key. */
  const failed = useRef<{ input: string; key: string } | undefined>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((input: Input<N>, callOptions: Pick<CallOptions, 'timeoutMs'> = {}): Promise<MutationResult<Output<N>>> => {
    if (inflight.current !== undefined) return inflight.current;
    const inputKey = stableKey(input);
    const key = failed.current?.input === inputKey ? failed.current.key : crypto.randomUUID();
    setState((s) => ({ ...s, pending: true, error: undefined }));
    const attempt = (async (): Promise<MutationResult<Output<N>>> => {
      try {
        const out = await data.api.call(name, input, { idempotencyKey: key, timeoutMs: callOptions.timeoutMs });
        failed.current = undefined;
        // The cell took a write: whatever paused writes has passed.
        if (routeInfo(name).writes) data.status.resume();
        if (optionsRef.current.refresh !== false) data.cache.invalidateAfter(name, optionsRef.current.invalidates);
        if (mounted.current) setState({ pending: false, error: undefined, data: out });
        optionsRef.current.onSuccess?.(out, input);
        return { ok: true, data: out };
      } catch (error) {
        // A refusal the cell decided is final for this intent; a failure in transit may be tried again with the same key.
        failed.current = isApiError(error) && error.status !== 0 && !error.retryable ? undefined : { input: inputKey, key };
        if (mounted.current) setState({ pending: false, error, data: undefined });
        return { ok: false, error };
      } finally {
        inflight.current = undefined;
      }
    })();
    inflight.current = attempt;
    return attempt;
  }, [data, name]);

  const reset = useCallback(() => {
    failed.current = undefined;
    setState({ pending: false, error: undefined, data: undefined });
  }, []);

  return { run, reset, pending: state.pending, error: state.error, data: state.data, blocked };
}
