// The generic engine's shared parts (spec 14.5): what a protocol engine is given to read
// with, error meanings, field values, the residual computed after the source, and the
// per-connection rate limits. Nothing here knows a provider; a protocol engine knows its
// protocol and nothing above it.

import type { EgressResponse, PreparedRequest, sendSftpRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import type { z } from 'zod';
import { SFTP_HOST_KEY_PARAMETER, type ErrorMeaning, type FieldType, type Manifest, type ManifestField, type ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import type { PushdownSplit, StepAggregate, StepFilter, StepSort } from '../../contracts/connect/step.contract.ts';
import { AppError, type ErrorCategory } from '../../utils/errors.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import { HOST_KEY, sftpTarget } from '../../utils/sftpTarget.util.ts';
import type { AgentChannel } from './agent.service.ts';
import type { SiloStoreChannel } from './siloStore.service.ts';

export type Row = Record<string, unknown>;

export interface ReadStats {
  pages: number;
  sourceRows: number;
  typeMismatches: number;
  retries: number;
}

/** What a protocol engine reads with. It never sees a secret. */
export interface ReadContext {
  manifest: Manifest;
  connection: { id: string; organisationId: string; agentPoolId: string | null };
  /** Connection parameters: public, never secret. */
  params: Record<string, string>;
  /** Fixed for the request: the only clock an expression sees. */
  now: Date;
  /** performance.now() past which the read is refused. */
  deadline: number;
  signal: AbortSignal;
  /** Rows the source may return for this step before it is refused (spec 7.10). */
  maxRows: number;
  /** Sends a request through the credential service, which places the secret. */
  send(request: PreparedRequest): Promise<EgressResponse>;
  /** Industrial (20.1): the connection's active broker or server, reached by the agent. */
  industrial?: {
    id: string; plugin: string; endpointUrl: string; securityPolicy: string;
    /** A signed OPC UA policy's application certificate (PEM) and the server certificate the owner pinned. */
    appCertificatePem: string | null; serverCertificateThumbprint: string | null;
  } | undefined;
  /**
   * Files (14.4): a directory's names or a file's bytes; for SFTP through the credential service,
   * which runs the session, and for a file share through the Silo Agent on its host.
   */
  files(operation: z.input<typeof sendSftpRequest.body>['operation']): Promise<z.output<typeof sendSftpRequest.response>>;
  /** Asks the OAuth engine to refresh the connection's token, under its lock. */
  refresh(): Promise<void>;
  agent: AgentChannel;
  /** Silo's own store (66.5), for a manifest whose transport names it. */
  siloStore: SiloStoreChannel;
  stats: ReadStats;
}

export interface ProtocolEngine {
  /** Rows keyed by field name, the native part of the step applied at the source. */
  read(ctx: ReadContext, object: ManifestObject, native: PushdownSplit['native'], fields: readonly ManifestField[]): Promise<Row[]>;
}

type FileOperation = z.input<typeof sendSftpRequest.body>['operation'];
type FileAnswer = z.output<typeof sendSftpRequest.response>;

/** A file share's root on the agent's host, from the manifest's file:/// base: an absolute path, a drive letter's kept. */
export function fileShareRoot(baseUrl: string): string {
  const path = decodeURIComponent(new URL(baseUrl).pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/**
 * Where an engine's files come from (14.4): SFTP's through the credential service, which runs
 * the session; a file share's through the connection's Silo Agent, on its host.
 */
export function filesFor(input: {
  manifest: Manifest; connection: { id: string; organisationId: string; agentPoolId: string | null; parameters?: Record<string, string> | undefined };
  agent: AgentChannel; deadline: number; signal: AbortSignal; sftp: (operation: FileOperation) => Promise<FileAnswer>;
}): (operation: FileOperation) => Promise<FileAnswer> {
  const { manifest } = input;
  const throughAgent = manifest.protocol.kind === 'file_share' || (manifest.protocol.kind === 'sftp' && manifest.transport.viaAgent);
  if (!throughAgent) return input.sftp;
  return async (operation) => {
    const { agentPoolId } = input.connection;
    const timeoutMs = Math.max(1_000, Math.floor(input.deadline - performance.now()));
    if (agentPoolId === null) throw new AppError('source_unreachable', 'this connection is read by its Silo Agent, and none is set', { code: 'agent.unavailable' });
    if (manifest.protocol.kind === 'file_share') {
      if (input.agent.files === undefined) throw new AppError('source_unreachable', 'no Silo Agent of the connection\'s pool reads file shares', { code: 'agent.unavailable' });
      return input.agent.files({
        organisationId: input.connection.organisationId, connectionId: input.connection.id, agentPoolId, root: fileShareRoot(manifest.transport.baseUrl!),
        operation, timeoutMs, signal: input.signal,
      });
    }
    // SFTP through the agent (14.4): the address from the manifest and the parameters, the host key the connection pins.
    const params = input.connection.parameters ?? {};
    const pinned = params[SFTP_HOST_KEY_PARAMETER];
    if (pinned === undefined || !HOST_KEY.test(pinned)) {
      throw new AppError('validation', `the connection pins no host key: set ${SFTP_HOST_KEY_PARAMETER} to the server's SHA256 fingerprint`, { code: 'sftp.host_key_missing' });
    }
    if (input.agent.sftp === undefined) throw new AppError('source_unreachable', 'no Silo Agent of the connection\'s pool reaches SFTP servers', { code: 'agent.unavailable' });
    const target = sftpTarget(manifest.transport.baseUrl!, params);
    return input.agent.sftp({
      organisationId: input.connection.organisationId, connectionId: input.connection.id, agentPoolId, host: target.host, port: target.port, basePath: target.basePath,
      hostKeySha256: pinned, operation, timeoutMs, signal: input.signal,
    });
  };
}

// ----------------------------------------------------------------------------- errors

const MEANING: Readonly<Record<ErrorMeaning, { category: ErrorCategory; message: string; retryable: boolean }>> = {
  auth: { category: 'unauthenticated', message: 'the source refused the connection\'s credentials; reconnect it', retryable: false },
  rate_limit: { category: 'rate_limited', message: 'the source is limiting requests', retryable: true },
  not_found: { category: 'not_found', message: 'the source has no such object', retryable: false },
  upstream: { category: 'upstream', message: 'the source failed', retryable: true },
  bounds: { category: 'bounds', message: 'the source refused the request as too large', retryable: false },
  conflict: { category: 'conflict', message: 'the source reported a conflict', retryable: false },
  validation: { category: 'validation', message: 'the source refused the request', retryable: false },
};

export class SourceError extends AppError {
  readonly meaning: ErrorMeaning;
  readonly retryAfterMs: number | undefined;

  constructor(meaning: ErrorMeaning, details: Record<string, string | number | boolean>, retryAfterMs?: number) {
    const m = MEANING[meaning];
    super(m.category, m.message, {
      code: `source.${meaning}`, details: { meaning, ...details }, retryable: m.retryable,
      ...(retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }),
    });
    this.meaning = meaning;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ErrorInput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  sqlstate: string;
}

/**
 * The manifest's rules in order, then the protocol's standard meaning (spec 14.5). Returns
 * the meaning and the delay before a retry, or undefined when the response is not an error.
 */
export async function classify(manifest: Manifest, input: ErrorInput, standard: (input: ErrorInput) => ErrorMeaning | undefined, now: Date)
  : Promise<{ meaning: ErrorMeaning; retryAfterMs: number | undefined } | undefined> {
  for (const rule of manifest.errors.classify) {
    if (await compileExpression('errors.when', 'cel', rule.when.cel).evaluate({ ...input }, now) === true) {
      const seconds = rule.retryAfter === undefined ? undefined
        : await compileExpression('errors.retryAfter', 'cel', rule.retryAfter.cel).evaluate({ ...input }, now) as number;
      return { meaning: rule.meaning, retryAfterMs: seconds === undefined ? retryAfterHeader(input.headers, now) : seconds * 1000 };
    }
  }
  const meaning = standard(input);
  return meaning === undefined ? undefined : { meaning, retryAfterMs: retryAfterHeader(input.headers, now) };
}

/** RFC 9110 Retry-After: seconds, or an HTTP date. */
export function retryAfterHeader(headers: Record<string, string>, now: Date): number | undefined {
  const value = headers['retry-after'];
  if (value === undefined) return undefined;
  if (/^\d{1,6}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Runs an attempt, retrying a rate-limited or failing source up to the manifest's attempts,
 * waiting as the source asks (or backing off), never past the read's deadline.
 */
export async function withRetries<T>(ctx: ReadContext, attempt: () => Promise<T>): Promise<T> {
  const attempts = ctx.manifest.limits.maxAttempts;
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      const retryable = error instanceof SourceError ? error.meaning === 'rate_limit' || error.meaning === 'upstream'
        : error instanceof AppError && error.category === 'source_unreachable';
      if (!retryable || n >= attempts) throw error;
      const asked = error instanceof SourceError ? error.retryAfterMs : undefined;
      const delay = Math.min(asked ?? 200 * 2 ** (n - 1), MAX_RETRY_DELAY_MS);
      if (performance.now() + delay >= ctx.deadline) throw error;
      ctx.stats.retries += 1;
      await sleep(delay, ctx.signal);
    }
  }
}

export function checkDeadline(ctx: ReadContext): void {
  if (performance.now() > ctx.deadline || ctx.signal.aborted) {
    throw new AppError('bounds', 'the read ran past its wall time; refused rather than returned in part', {
      code: 'connect.wall_time', details: { bound: 'wall_time' },
    });
  }
}

export function rowsBound(ctx: ReadContext): AppError {
  return new AppError('bounds', 'the source returned more rows than one step may read; narrow the question', {
    code: 'connect.rows_per_source_step', details: { bound: 'rows_per_source_step', limit: ctx.maxRows },
  });
}

// ----------------------------------------------------------------------------- values

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
// A moment at midnight UTC: how a database whose dates carry a time (Oracle's DATE) gives a date.
const MIDNIGHT = /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|\+00:?00)$/;

/** A source value as its declared type; a value that does not fit is null and counted. */
export function coerce(value: unknown, type: FieldType, stats: ReadStats): unknown {
  if (value === null || value === undefined) return null;
  const mismatch = () => {
    stats.typeMismatches += 1;
    return null;
  };
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : mismatch();
    case 'integer': {
      if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : mismatch();
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d{1,16}$/.test(value.trim()) ? Number(value) : NaN;
      return Number.isSafeInteger(n) ? n : mismatch();
    }
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      return Number.isFinite(n) ? n : mismatch();
    }
    case 'boolean':
      // Databases without a boolean type keep one as 1 or 0 (MySQL's TINYINT(1), Oracle's NUMBER(1)).
      return typeof value === 'boolean' ? value : value === 'true' || value === 1 ? true : value === 'false' || value === 0 ? false : mismatch();
    case 'date':
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === 'string' && MIDNIGHT.test(value)) return value.slice(0, 10);
      return typeof value === 'string' && DATE.test(value) ? value : mismatch();
    case 'date-time':
      if (value instanceof Date) return value.toISOString();
      return typeof value === 'string' && DATE_TIME.test(value) ? value : mismatch();
    case 'json':
      return value;
  }
}

export function getPath(record: unknown, path: string): unknown {
  let current = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ----------------------------------------------------------------------------- residual

const comparable = (v: unknown): number | string | boolean | null =>
  v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : JSON.stringify(v);

function compare(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  const sx = String(x);
  const sy = String(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

function matches(row: Row, filter: StepFilter): boolean {
  const v = row[filter.field];
  switch (filter.op) {
    case 'is_null': return v === null || v === undefined;
    case 'is_not_null': return v !== null && v !== undefined;
    case 'eq': return v !== null && v !== undefined && compare(v, filter.value) === 0;
    case 'ne': return v !== null && v !== undefined && compare(v, filter.value) !== 0;
    case 'lt': return v !== null && v !== undefined && compare(v, filter.value) < 0;
    case 'lte': return v !== null && v !== undefined && compare(v, filter.value) <= 0;
    case 'gt': return v !== null && v !== undefined && compare(v, filter.value) > 0;
    case 'gte': return v !== null && v !== undefined && compare(v, filter.value) >= 0;
    case 'in': return v !== null && v !== undefined && (filter.value as unknown[]).some((item) => compare(v, item) === 0);
    case 'contains': return typeof v === 'string' && v.includes(String(filter.value));
    case 'starts_with': return typeof v === 'string' && v.startsWith(String(filter.value));
  }
}

export function sortRows(rows: Row[], sort: readonly StepSort[]): Row[] {
  if (sort.length === 0) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const s of sort) {
        const c = compare(a.row[s.field], b.row[s.field]);
        if (c !== 0) return s.direction === 'desc' ? -c : c;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export function aggregateRows(rows: Row[], aggregate: StepAggregate): Row[] {
  const groups = new Map<string, { key: Row; rows: Row[] }>();
  for (const row of rows) {
    const key = Object.fromEntries(aggregate.groupBy.map((g) => [g, row[g] ?? null]));
    const id = JSON.stringify(aggregate.groupBy.map((g) => row[g] ?? null));
    const group = groups.get(id) ?? { key, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  if (groups.size === 0 && aggregate.groupBy.length === 0) groups.set('[]', { key: {}, rows: [] });
  return [...groups.values()].map(({ key, rows: members }) => {
    const out: Row = { ...key };
    for (const m of aggregate.measures) {
      const values = m.field === undefined ? [] : members.map((r) => r[m.field!]).filter((v) => v !== null && v !== undefined);
      const numbers = values.filter((v): v is number => typeof v === 'number');
      switch (m.fn) {
        case 'count': out[m.as] = m.field === undefined ? members.length : values.length; break;
        case 'sum': out[m.as] = numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0); break;
        case 'avg': out[m.as] = numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length; break;
        case 'min': out[m.as] = values.length === 0 ? null : values.reduce((a, b) => (compare(a, b) <= 0 ? a : b)); break;
        case 'max': out[m.as] = values.length === 0 ? null : values.reduce((a, b) => (compare(a, b) >= 0 ? a : b)); break;
      }
    }
    return out;
  });
}

/** The residual part of a step, in order: filter, aggregate, sort, limit. */
export function applyResidual(rows: Row[], residual: PushdownSplit['residual']): Row[] {
  let out = residual.filters.length === 0 ? rows : rows.filter((row) => residual.filters.every((f) => matches(row, f)));
  if (residual.aggregate !== null) out = aggregateRows(out, residual.aggregate);
  out = sortRows(out, residual.sort);
  if (residual.limit !== null) out = out.slice(0, residual.limit);
  return out;
}

// ----------------------------------------------------------------------------- limits

interface Limiter {
  tokens: number;
  updatedAt: number;
  active: number;
  waiting: (() => void)[];
}

const limiters = new Map<string, Limiter>();

/**
 * The manifest's per-connection limits (spec 14.3 rate_limits): a token bucket at
 * requestsPerSecond and at most maxConcurrent requests in flight, in this process. The bucket
 * holds at least one token, so a rate under one a second still sends, one request at a time.
 */
export async function limited<T>(ctx: ReadContext, work: () => Promise<T>): Promise<T> {
  const { requestsPerSecond, maxConcurrent } = ctx.manifest.limits;
  if (requestsPerSecond === undefined && maxConcurrent === undefined) return work();
  const capacity = Math.max(1, requestsPerSecond ?? 0);
  const limiter = limiters.get(ctx.connection.id) ?? { tokens: capacity, updatedAt: performance.now(), active: 0, waiting: [] };
  limiters.set(ctx.connection.id, limiter);
  if (maxConcurrent !== undefined) {
    while (limiter.active >= maxConcurrent) await new Promise<void>((resolve) => limiter.waiting.push(resolve));
  }
  limiter.active += 1;
  try {
    if (requestsPerSecond !== undefined) {
      for (;;) {
        const now = performance.now();
        limiter.tokens = Math.min(capacity, limiter.tokens + ((now - limiter.updatedAt) / 1000) * requestsPerSecond);
        limiter.updatedAt = now;
        if (limiter.tokens >= 1) {
          limiter.tokens -= 1;
          break;
        }
        const wait = ((1 - limiter.tokens) / requestsPerSecond) * 1000;
        if (now + wait >= ctx.deadline) checkDeadline({ ...ctx, deadline: 0 });
        await sleep(wait, ctx.signal);
      }
    }
    return await work();
  } finally {
    limiter.active -= 1;
    limiter.waiting.shift()?.();
  }
}
