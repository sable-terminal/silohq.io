// Calls to the cell's public API (/api/v1), same-origin, typed by the gateway's own route
// definitions: their types only, so no server code reaches the browser, and the route table
// generated from them (routes.generated.ts) for each route's method, path, session, access and
// whether it writes.
//
// The browser holds the session only as the __Host- cookie, which page script never sees; a
// state-changing call carries the x-silo-csrf header the gateway asks for, and a keyed one an
// Idempotency-Key, the same key for every retry of one intent.
//
// Robustness, in one place rather than in every page:
// - a call that keeps nothing (a GET, or a route that declares it reads) is retried when the
//   network fails or the cell sheds it, after the time the cell gives, a few times at most;
// - a keyed write is retried the same way with the same key, so the cell applies it once; an
//   unkeyed write is never retried, because a retry could apply it twice;
// - every call has a time limit, and is aborted when its caller no longer wants it;
// - what the whole client must react to (the session ended, writes paused, the cell shedding,
//   the network gone or back) is announced on `apiSignals`, once, for the shell to show.

import type { RouteInput, RouteOutput } from '../../../server/src/contracts/gateway/publicRoute.contract.ts';
import { ROUTES, type Routes } from './routes.generated.ts';

export type RouteName = keyof Routes;
export type Input<N extends RouteName> = RouteInput<Routes[N]>;
export type Output<N extends RouteName> = RouteOutput<Routes[N]>;
export type RouteInfo = (typeof ROUTES)[RouteName];

/** Who may call a route: a permission the gateway checks, the person's own records, its service's own rule, or anyone. */
export type Access = { readonly permission: string } | 'own' | 'service' | 'open';

export function routeInfo(name: RouteName): { method: string; path: string; keyed: boolean; session: string; access: Access; writes: boolean } {
  return ROUTES[name] as never;
}

/** The permission the gateway checks for a route, when it names one. */
export function permissionOf(name: RouteName): string | undefined {
  const access = routeInfo(name).access;
  return typeof access === 'object' ? access.permission : undefined;
}

/** A field the request got wrong, as the gateway names it: `body.name`, `query.limit`. */
export interface Issue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** How the client treats a failure. */
export type FailureKind =
  | 'offline' // the request did not reach the cell
  | 'timeout' // no answer in time
  | 'unauthenticated' // the session ended
  | 'mfa' // the session needs its second factor
  | 'forbidden' // not permitted
  | 'not_found'
  | 'conflict' // stale version, duplicate name, a state that does not allow it
  | 'paused' // the organisation's writes are paused (a cell migration)
  | 'validation' // the request was wrong: see issues
  | 'refused' // a bound or capacity refusal (spec 12.1): a correct answer, not a fault
  | 'overloaded' // shed or rate limited: try again later
  | 'unavailable' // a source or upstream could not be reached
  | 'internal';

/** A refusal or failure from the API, as the gateway states it: never more than it says. */
export class ApiError extends Error {
  readonly route: RouteName | undefined;
  readonly status: number;
  readonly category: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: Readonly<Record<string, unknown>>;
  readonly issues: readonly Issue[];
  /** Quoted to support when a failure persists. */
  readonly correlationId: string | undefined;

  constructor(status: number, body: unknown, correlationId: string | undefined, route?: RouteName, fallback?: { category: string; code: string; message: string; retryable: boolean }) {
    const raw = typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : undefined;
    const error = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const message = typeof error['message'] === 'string' ? error['message'] : fallback?.message ?? `the request failed (${status})`;
    super(message);
    this.name = 'ApiError';
    this.route = route;
    this.status = status;
    this.category = typeof error['category'] === 'string' ? error['category'] : fallback?.category ?? (status >= 500 ? 'internal' : 'validation');
    this.code = typeof error['code'] === 'string' ? error['code'] : fallback?.code ?? 'unknown';
    this.retryable = typeof error['retryable'] === 'boolean' ? error['retryable'] : fallback?.retryable ?? false;
    this.retryAfterSeconds = typeof error['retryAfterSeconds'] === 'number' ? error['retryAfterSeconds'] : undefined;
    this.details = typeof error['details'] === 'object' && error['details'] !== null ? error['details'] as Record<string, unknown> : {};
    this.issues = Array.isArray(error['issues'])
      ? (error['issues'] as unknown[]).filter((i): i is Issue => typeof i === 'object' && i !== null && typeof (i as Issue).path === 'string' && typeof (i as Issue).message === 'string')
      : [];
    this.correlationId = correlationId;
  }

  get kind(): FailureKind {
    if (this.status === 0) return this.category === 'timeout' ? 'timeout' : 'offline';
    if (this.code === 'tenant_migrations.writes_paused') return 'paused';
    if (this.code === 'gateway.mfa_required') return 'mfa';
    switch (this.category) {
      case 'unauthenticated': return 'unauthenticated';
      case 'forbidden': return 'forbidden';
      case 'not_found': return 'not_found';
      case 'conflict': return 'conflict';
      case 'validation': return 'validation';
      case 'bounds': return 'refused';
      case 'capacity': case 'rate_limited': return 'overloaded';
      case 'source_unreachable': case 'upstream': case 'unavailable': return 'unavailable';
      case 'timeout': return 'timeout';
      default: return 'internal';
    }
  }

  /** The message as a sentence: the gateway writes them in lower case for logs and people alike. */
  get sentence(): string {
    const text = this.message.trim();
    if (text === '') return 'Something went wrong.';
    const first = text.charAt(0).toUpperCase() + text.slice(1);
    return /[.!?]$/.test(first) ? first : `${first}.`;
  }

  /** The issue for one field of the body, by its name or dotted path within the body. */
  issueFor(field: string): Issue | undefined {
    return this.issues.find((issue) => issue.path === `body.${field}` || issue.path.startsWith(`body.${field}.`));
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** The path with its :name segments filled from params, each encoded. */
export function pathOf(template: string, params: Readonly<Record<string, unknown>> | undefined): string {
  return template.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === '') throw new Error(`the path parameter ${name} is missing`);
    return encodeURIComponent(String(value));
  });
}

/** The query string: arrays repeat their key, absent values are left out, objects travel as JSON. */
export function queryOf(query: Readonly<Record<string, unknown>> | undefined): string {
  if (query === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/** What the whole client reacts to, announced once per change. */
export type ApiSignal =
  | { type: 'unauthenticated'; route: RouteName }
  | { type: 'authenticated' }
  | { type: 'mfa'; route: RouteName }
  | { type: 'paused' }
  | { type: 'overloaded'; retryAfterSeconds: number | undefined }
  | { type: 'offline' }
  | { type: 'reachable' };

type Listener = (signal: ApiSignal) => void;

export interface ApiSignals {
  subscribe(listener: Listener): () => void;
  emit(signal: ApiSignal): void;
}

export function createSignals(): ApiSignals {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(signal) {
      for (const listener of [...listeners]) {
        try {
          listener(signal);
        } catch {
          // One listener's fault never stops the others hearing.
        }
      }
    },
  };
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
  /** For a keyed route: one key per intent, reused on its retries. Made when absent. */
  idempotencyKey?: string | undefined;
  /** Milliseconds before the call is abandoned. Default 60 seconds. */
  timeoutMs?: number | undefined;
  /** Attempts in all, for a call that may be retried. Default 3; 1 never retries. */
  attempts?: number | undefined;
}

/** Sends a request; injectable for tests. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** Waits; injectable for tests. */
export type Sleep = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPTS = 3;
const MAX_WAIT_MS = 15_000;

const sleepFor: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', stop);
    resolve();
  }, ms);
  const stop = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  signal?.addEventListener('abort', stop, { once: true });
});

/** Whether a failure may be tried again, for a call that may be retried at all. */
const transient = (error: ApiError): boolean =>
  error.kind === 'offline' || error.kind === 'overloaded' || (error.kind === 'unavailable' && error.retryable) || (error.status === 502 || error.status === 504);

/** How long to wait before attempt n (1-based retry count): the cell's figure, else backoff with jitter. */
export function waitBefore(retry: number, error: ApiError, random: () => number = Math.random): number {
  if (error.retryAfterSeconds !== undefined) return Math.min(error.retryAfterSeconds * 1000, MAX_WAIT_MS);
  const base = Math.min(500 * 2 ** (retry - 1), MAX_WAIT_MS);
  return Math.round(base / 2 + random() * base / 2);
}

export interface Api {
  call<N extends RouteName>(name: N, input: Input<N>, options?: CallOptions): Promise<Output<N>>;
  readonly signals: ApiSignals;
}

export function createApi(fetcher: Fetch = (url, init) => fetch(url, init), sleep: Sleep = sleepFor): Api {
  const signals = createSignals();
  let offline = false;

  const reachable = () => {
    if (offline) {
      offline = false;
      signals.emit({ type: 'reachable' });
    }
  };

  async function once<N extends RouteName>(name: N, input: Input<N>, key: string | undefined, options: CallOptions): Promise<Output<N>> {
    const route = routeInfo(name);
    const parts = (input ?? {}) as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    const headers: Record<string, string> = { accept: 'application/json' };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('timed out', 'TimeoutError')), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal]);
    const init: RequestInit = { method: route.method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal };
    if (route.method !== 'GET') {
      headers['x-silo-csrf'] = '1';
      if (parts.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(parts.body);
      }
    }
    if (key !== undefined) headers['idempotency-key'] = key;
    const url = `${pathOf(route.path, parts.params)}${queryOf(parts.query)}`;
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (error) {
      clearTimeout(timer);
      // The caller gave up: not a failure of the cell's.
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (timeout.signal.aborted) {
        throw new ApiError(0, undefined, undefined, name, { category: 'timeout', code: 'client.timeout', message: 'Silo did not answer in time', retryable: true });
      }
      if (!offline) {
        offline = true;
        signals.emit({ type: 'offline' });
      }
      throw new ApiError(0, undefined, undefined, name, { category: 'unavailable', code: 'client.offline', message: 'Silo could not be reached: check your connection', retryable: true });
    }
    clearTimeout(timer);
    reachable();
    const correlationId = response.headers.get('x-correlation-id') ?? undefined;
    if (response.status === 204) return undefined as Output<N>;
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ApiError(0, undefined, correlationId, name, { category: 'unavailable', code: 'client.interrupted', message: 'the answer was interrupted', retryable: true });
    }
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new ApiError(response.status, undefined, correlationId, name);
    }
    if (!response.ok) {
      const error = new ApiError(response.status, body, correlationId, name);
      if (error.kind === 'unauthenticated' && route.session !== 'none') signals.emit({ type: 'unauthenticated', route: name });
      else if (error.kind === 'mfa') signals.emit({ type: 'mfa', route: name });
      else if (error.kind === 'paused') signals.emit({ type: 'paused' });
      else if (error.kind === 'overloaded') signals.emit({ type: 'overloaded', retryAfterSeconds: error.retryAfterSeconds });
      throw error;
    }
    // A session answered: whatever said it had ended is out of date (signed in again since).
    if (route.session !== 'none') signals.emit({ type: 'authenticated' });
    return body as Output<N>;
  }

  async function call<N extends RouteName>(name: N, input: Input<N>, options: CallOptions = {}): Promise<Output<N>> {
    const route = routeInfo(name);
    const key = route.keyed ? options.idempotencyKey ?? crypto.randomUUID() : undefined;
    // A call that keeps nothing, or a keyed write the cell applies once whatever it is sent.
    const retriable = !route.writes || route.method === 'GET' || key !== undefined;
    const attempts = retriable ? Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS) : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(name, input, key, options);
      } catch (error) {
        if (!(error instanceof ApiError) || attempt >= attempts || !transient(error)) throw error;
        await sleep(waitBefore(attempt, error), options.signal);
      }
    }
  }

  return { call, signals };
}

export const api = createApi();
