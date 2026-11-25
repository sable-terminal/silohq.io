// Calling another service through its contract (spec 7.1). The request is validated
// before it leaves and the response when it arrives: the caller's half of "validated by
// Zod on both sides". The callee's half is http.infra.ts.
//
// - mTLS with this service's certificate; the callee checks the identity against the
//   contract's callers, and this client refuses to call a contract that does not list it.
// - The request context (organisation, actor, user) and the correlation id travel as
//   headers, the trace context as traceparent.
// - A GET, or a keyed call (which must carry an idempotency key), is retried on a
//   retryable failure; any other call is sent once, because repeating it is not known
//   to be safe ("callers retry under idempotency keys").
// - An error response arrives as the AppError the callee raised.

import { readFileSync } from 'node:fs';
import { Agent as PlainAgent, request as plainRequest, type IncomingHttpHeaders } from 'node:http';
import { Agent as TlsAgent, request as tlsRequest } from 'node:https';
import type { z } from 'zod';
import type { HttpConfig } from '../config/http.config.ts';
import type { ServiceName } from '../config/service.config.ts';
import {
  CONTEXT_HEADERS, CORRELATION_HEADER, DEV_CALLER_CELL_HEADER, DEV_CALLER_HEADER, errorBody, IDEMPOTENCY_HEADER,
  type AnyContract, type CallInput, type CallOutput,
} from '../contracts/endpoint.contract.ts';
import { AppError, ERROR_CATEGORIES, isAppError, type ErrorCategory } from '../utils/errors.util.ts';
import { uuidv7 } from '../utils/id.util.ts';
import { retry } from '../utils/retry.util.ts';
import type { RequestContext } from './postgres.infra.ts';
import { injectTraceContext } from './telemetry.infra.ts';

export interface CallOptions {
  /** The organisation, actor and user the call is made for. */
  request?: RequestContext;
  correlationId?: string;
  /** Required for a keyed contract. Keep it with the work, so a retry sends the same key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * One replica of the called service, for a call that must reach the replica holding
   * something (an agent's tunnel): its scheme, host and port. TLS still verifies the
   * service's own name, and the scheme must be the service's.
   */
  replicaUrl?: string;
}

export interface ServiceClient {
  call<C extends AnyContract>(contract: C, input: CallInput<C>, options?: CallOptions): Promise<CallOutput<C>>;
  close(): void;
}

export interface ServiceClientOptions {
  /** The calling service: its certificate identity, and what the contract must list. */
  caller: ServiceName;
  /**
   * The calling cell. Under mTLS the certificate carries it; without TLS (development and
   * tests) it is sent in a header, so a global-tier service can tell cells apart.
   */
  cell?: string;
  http: HttpConfig;
  /** Per call, unless the call names its own. */
  timeoutMs?: number;
  /** A response over this is refused, never truncated. */
  maxResponseBytes?: number;
  /** Attempts for a GET or a keyed call. */
  attempts?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  const { http } = options;
  const tls = http.tlsCertFile !== undefined
    ? { cert: readFileSync(http.tlsCertFile), key: readFileSync(http.tlsKeyFile!), ca: readFileSync(http.tlsCaFile!) }
    : undefined;
  const tlsAgent = new TlsAgent({ keepAlive: true, ...(tls ?? {}), minVersion: 'TLSv1.3' });
  const plainAgent = new PlainAgent({ keepAlive: true });
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const baseUrl = (service: ServiceName): string =>
    http.serviceUrls[service] ?? http.serviceUrlTemplate.replaceAll('{service}', service);

  /** Where a call goes: the service, or one replica of it, verified by the service's own name. */
  const target = (service: ServiceName, replicaUrl: string | undefined): { base: string; servername?: string } => {
    const base = baseUrl(service);
    if (replicaUrl === undefined) return { base };
    const replica = new URL(replicaUrl);
    const own = new URL(base);
    if (replica.protocol !== own.protocol || replica.pathname !== '/' || replica.search !== '' || replica.username !== '') {
      throw new AppError('validation', 'a replica address is the service\'s scheme, a host and a port', { code: 'service.replica_invalid' });
    }
    return { base: replica.origin, servername: own.hostname };
  };

  const send = (url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal,
    servername?: string): Promise<Reply> => new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    if (secure && tls === undefined) {
      reject(new AppError('configuration', 'calling over https needs this service\'s certificate', { code: 'config.http.tls' }));
      return;
    }
    const req = (secure ? tlsRequest : plainRequest)(url, {
      method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
      agent: secure ? tlsAgent : plainAgent, signal, ...(secure && servername !== undefined ? { servername } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          req.destroy(new AppError('bounds', `refused: the response exceeded ${maxResponseBytes} bytes`, {
            code: 'bound.response_bytes', details: { limit: maxResponseBytes }, retryable: false,
          }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });

  return {
    async call<C extends AnyContract>(contract: C, input: CallInput<C>, callOptions: CallOptions = {}): Promise<CallOutput<C>> {
      if (!contract.callers.includes(options.caller)) {
        throw new AppError('forbidden', `${options.caller} is not a listed caller of ${contract.id} (spec 7.1)`, { code: 'caller.not_listed' });
      }
      const raw = input as { params?: unknown; query?: unknown; body?: unknown };
      const issues: string[] = [];
      const parsed: Record<string, unknown> = {};
      for (const [part, schema, value] of [['params', contract.params, raw.params ?? {}], ['query', contract.query, raw.query ?? {}],
        ['body', contract.body, raw.body]] as [string, z.ZodType, unknown][]) {
        const result = schema.safeParse(value);
        if (result.success) parsed[part] = result.data;
        else issues.push(...result.error.issues.map((i) => [part, ...i.path.map(String)].join('.')));
      }
      if (issues.length > 0) {
        throw new AppError('validation', `the call to ${contract.id} does not match its contract`, {
          code: 'contract.request_invalid', details: { issues: issues.length, first: issues[0]! },
        });
      }
      if (contract.idempotency === 'keyed' && callOptions.idempotencyKey === undefined) {
        throw new AppError('validation', `${contract.id} is keyed: pass an idempotency key`, { code: 'idempotency.key_missing' });
      }

      // Path and query go out as the caller gave them; the callee parses them again.
      const params = (raw.params ?? {}) as Record<string, unknown>;
      const path = contract.path.replace(/:([A-Za-z0-9]+)/g, (_, name: string) => encodeURIComponent(String(params[name])));
      const destination = target(contract.service, callOptions.replicaUrl);
      const url = new URL(path, destination.base);
      for (const [name, value] of Object.entries((raw.query ?? {}) as Record<string, unknown>)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
      }
      const headers: Record<string, string> = {
        accept: 'application/json',
        [CORRELATION_HEADER]: callOptions.correlationId ?? uuidv7(),
        ...injectTraceContext(),
      };
      if (tls === undefined) {
        headers[DEV_CALLER_HEADER] = options.caller;
        if (options.cell !== undefined) headers[DEV_CALLER_CELL_HEADER] = options.cell;
      }
      for (const [field, header] of Object.entries(CONTEXT_HEADERS) as [keyof RequestContext, string][]) {
        const value = callOptions.request?.[field];
        if (value !== undefined) headers[header] = value;
      }
      if (callOptions.idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER] = callOptions.idempotencyKey;
      let body: Buffer | undefined;
      if (raw.body !== undefined) {
        body = Buffer.from(JSON.stringify(raw.body), 'utf8');
        headers['content-type'] = 'application/json';
      }

      const once = async (): Promise<CallOutput<C>> => {
        // The call's own wait, else the operation's declared bound (a plan run, a scenario run), else the client's.
        const timeoutMs = callOptions.timeoutMs ?? contract.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const signal = callOptions.signal ? AbortSignal.any([callOptions.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        let reply: Reply;
        try {
          reply = await send(url, contract.method, headers, body, signal, destination.servername);
        } catch (error) {
          if (isAppError(error)) throw error;
          if (signal.aborted && callOptions.signal?.aborted !== true) {
            throw new AppError('timeout', `${contract.id} did not answer within ${timeoutMs} ms`, {
              code: 'service.timeout', details: { service: contract.service }, cause: error,
            });
          }
          throw new AppError('unavailable', `${contract.service} could not be reached`, {
            code: 'service.unreachable', details: { service: contract.service }, cause: error,
          });
        }
        if (reply.status >= 200 && reply.status < 300) {
          const json = reply.status === 204 || reply.body.length === 0 ? undefined : parseJson(reply.body);
          const checked = contract.response.safeParse(json);
          if (!checked.success) {
            throw new AppError('upstream', `${contract.id} answered with a body that does not match its contract`, {
              code: 'contract.response_invalid', details: { service: contract.service, issues: checked.error.issues.length },
            });
          }
          return checked.data as CallOutput<C>;
        }
        throw errorFromReply(contract, reply);
      };

      const safeToRepeat = contract.method === 'GET' || contract.idempotency === 'keyed';
      return retry(once, {
        attempts: safeToRepeat ? (options.attempts ?? 3) : 1,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      });
    },
    close() {
      tlsAgent.destroy();
      plainAgent.destroy();
    },
  };
}

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return Symbol('not json');
  }
};

// The callee's error body back into the AppError it raised. Anything else is upstream.
function errorFromReply(contract: AnyContract, reply: Reply): AppError {
  const parsed = errorBody.safeParse(parseJson(reply.body));
  if (!parsed.success) {
    return new AppError(reply.status >= 500 ? 'upstream' : 'internal', `${contract.service} answered ${reply.status} without an error body`, {
      code: 'service.bad_error', details: { service: contract.service, status: reply.status },
    });
  }
  const { error } = parsed.data;
  const category: ErrorCategory = (ERROR_CATEGORIES as readonly string[]).includes(error.category)
    ? error.category as ErrorCategory : 'upstream';
  const retryAfter = reply.headers['retry-after'];
  const retryAfterSeconds = error.retryAfterSeconds ?? (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined);
  return new AppError(category, error.message, {
    code: error.code,
    details: { ...(error.details ?? {}), service: contract.service },
    retryable: error.retryable,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}
