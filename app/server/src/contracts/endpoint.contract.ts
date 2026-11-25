// Service contracts. "Every body crossing a service boundary is validated by Zod on both
// sides" (spec 7.1): a contract names one endpoint of one service, who may call it, what
// request context the caller must send, and the Zod schemas of the request and the
// response. The callee's router (src/process.ts) and the caller's client
// (infra/serviceClient.infra.ts) both read it, so the two sides cannot disagree.
//
// Contracts are declarations only: no I/O, no handler. Each service's contracts live in
// src/contracts/<service>/<name>.contract.ts and are built from the table schemas in
// src/schemas with .pick() and .extend().
//
// Rules a contract cannot break:
// - only services in `callers` reach it (checked against the caller's mTLS identity);
// - `context` says which identity headers must arrive: 'organisation' for a tenant
//   request (the organisation, and the acting membership or service principal),
//   'user' for a person before an organisation is chosen, 'none' for neither;
// - a GET changes nothing and is never keyed; any other method declares its idempotency:
//   'keyed' (the caller sends an Idempotency-Key and a retry returns the first result) or
//   'none' (the operation says why repeating it is safe);
// - path parameters, query and body are all schemas; query values arrive as strings, so
//   a query schema coerces.

import { z } from 'zod';
import type { ServiceName } from '../config/service.config.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What is shed under load, first to last (spec 12.4). A contract that names none of these is
 * never shed: approvals, revert and audit among them (infra/load.infra.ts).
 */
export const SHED_ORDER = [
  'recognition_run', 'index_rebuild', 'simulation', 'export_render', 'subscription', 'compile', 'view_run', 'cron', 'action_execution', 'session_auth',
] as const;
export type ShedClass = (typeof SHED_ORDER)[number];
export type ContextRequirement = 'organisation' | 'user' | 'none';
export type Idempotency = 'keyed' | 'none';

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ContractDefinition<
  P extends ObjectSchema, Q extends ObjectSchema, B extends z.ZodType, R extends z.ZodType,
> {
  service: ServiceName;
  /** The operation, lowerCamelCase: 'createSession'. Logs and metrics name it service.name. */
  name: string;
  method: HttpMethod;
  /** Express-style, with :name for each path parameter. */
  path: `/${string}`;
  callers: readonly ServiceName[];
  context: ContextRequirement;
  idempotency: Idempotency;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** Default 200, or 204 when the response is z.undefined(). */
  status?: 200 | 201 | 202 | 204;
  /** Lower than the process limit (HTTP_MAX_BODY_BYTES) where the body is small by nature. */
  maxBodyBytes?: number;
  /**
   * How long a caller waits for the answer, where the operation is bounded by more than the
   * client's default (ten seconds): its own bound and a margin to answer with the refusal that
   * bound gives. Every caller and the gateway's forwarding wait this long, unless a call says
   * otherwise. At most four and a half minutes, inside the gateway's five-minute request bound.
   */
  timeoutMs?: number;
  /** The work's place in the shedding order under load (12.4); none: never shed. */
  shed?: ShedClass;
}

export interface Contract<
  P extends ObjectSchema = ObjectSchema, Q extends ObjectSchema = ObjectSchema,
  B extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly service: ServiceName;
  readonly name: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly callers: readonly ServiceName[];
  readonly context: ContextRequirement;
  readonly idempotency: Idempotency;
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  readonly response: R;
  readonly status: 200 | 201 | 202 | 204;
  readonly maxBodyBytes: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly shed: ShedClass | undefined;
}

// Contracts whose schemas are not known statically, as registries and routers hold them.
export type AnyContract = Contract<any, any, any, any>;

type Empty = z.ZodObject<{}, z.core.$strict>;

// A part may be left out when an empty object satisfies its schema: no schema, or every
// field optional.
type Part<S extends z.ZodType, K extends string> = {} extends z.input<S>
  ? { [P in K]?: z.input<S> }
  : { [P in K]: z.input<S> };

/** What a caller passes. */
export type CallInput<C extends AnyContract> =
  & Part<C['params'], 'params'>
  & Part<C['query'], 'query'>
  & (C['body'] extends z.ZodUndefined ? { body?: undefined } : Part<C['body'], 'body'>);

/** What a handler receives: every part parsed. */
export interface ParsedInput<C extends AnyContract> {
  params: z.output<C['params']>;
  query: z.output<C['query']>;
  body: z.output<C['body']>;
}

/** What a handler returns, before the response schema parses it. */
export type HandlerOutput<C extends AnyContract> = z.input<C['response']>;
/** What a caller receives, after the response schema parsed it. */
export type CallOutput<C extends AnyContract> = z.output<C['response']>;

const NAME = /^[a-z][A-Za-z0-9]{1,63}$/;
/** A contract's longest declared wait: inside the gateway's five-minute request bound (Node's requestTimeout). */
export const MAX_TIMEOUT_MS = 270_000;
const SEGMENT = /^(?::[a-z][A-Za-z0-9]*|[a-z0-9][a-z0-9._-]*)$/;
const registry = new Map<string, AnyContract>();

export function defineContract<
  const P extends ObjectSchema = Empty, const Q extends ObjectSchema = Empty,
  const B extends z.ZodType = z.ZodUndefined, const R extends z.ZodType = z.ZodType,
>(definition: ContractDefinition<P, Q, B, R>): Contract<P, Q, B, R> {
  const id = `${definition.service}.${definition.name}`;
  const where = `contract ${id}`;
  if (!NAME.test(definition.name)) throw new TypeError(`${where}: the name is lowerCamelCase`);
  if (registry.has(id)) throw new TypeError(`${where} is already defined`);
  const segments = definition.path.split('/').slice(1);
  if (definition.path !== '/' && segments.some((s) => !SEGMENT.test(s))) {
    throw new TypeError(`${where}: each path segment is lowercase text or a :parameter`);
  }
  const pathParams = segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
  const params = (definition.params ?? z.strictObject({})) as P;
  const declared = Object.keys(params.shape).sort();
  if (declared.join(',') !== [...pathParams].sort().join(',')) {
    throw new TypeError(`${where}: the params schema must name exactly the path parameters (${pathParams.join(', ') || 'none'})`);
  }
  for (const existing of registry.values()) {
    if (existing.service === definition.service && existing.method === definition.method
      && existing.path.replace(/:[^/]+/g, ':') === definition.path.replace(/:[^/]+/g, ':')) {
      throw new TypeError(`${where}: ${definition.method} ${definition.path} is already ${existing.id}`);
    }
  }
  if (definition.callers.length === 0) throw new TypeError(`${where}: name at least one caller (spec 7.1)`);
  if (definition.method === 'GET' && definition.idempotency !== 'none') {
    throw new TypeError(`${where}: a GET changes nothing, so it is never keyed`);
  }
  if (definition.method === 'GET' && definition.body !== undefined) throw new TypeError(`${where}: a GET has no body`);
  // Idempotency keys live in redis-data under the organisation (design: idem keyspace).
  if (definition.idempotency === 'keyed' && definition.context !== 'organisation') {
    throw new TypeError(`${where}: a keyed operation runs in an organisation's context`);
  }
  if (definition.timeoutMs !== undefined && !(Number.isInteger(definition.timeoutMs) && definition.timeoutMs >= 1_000 && definition.timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new TypeError(`${where}: a timeout is whole milliseconds from one second to ${MAX_TIMEOUT_MS}`);
  }
  const response = definition.response;
  const status = definition.status ?? (response instanceof z.ZodUndefined ? 204 : 200);
  if ((status === 204) !== (response instanceof z.ZodUndefined)) {
    throw new TypeError(`${where}: status 204 exactly when the response is z.undefined()`);
  }
  const contract: Contract<P, Q, B, R> = {
    id,
    service: definition.service,
    name: definition.name,
    method: definition.method,
    path: definition.path,
    pathParams,
    callers: [...definition.callers],
    context: definition.context,
    idempotency: definition.idempotency,
    params,
    query: (definition.query ?? z.strictObject({})) as Q,
    body: (definition.body ?? z.undefined()) as B,
    response,
    status,
    maxBodyBytes: definition.maxBodyBytes,
    timeoutMs: definition.timeoutMs,
    shed: definition.shed,
  };
  registry.set(id, contract);
  return contract;
}

/** Every contract defined in this process, for a service's router and for checks. */
export function definedContracts(service?: ServiceName): readonly AnyContract[] {
  return [...registry.values()].filter((c) => service === undefined || c.service === service);
}

// The headers that carry identity and correlation between services. Trusted only from a
// caller whose mTLS identity is listed on the contract.
export const CONTEXT_HEADERS = {
  organisationId: 'x-silo-organisation-id',
  membershipId: 'x-silo-membership-id',
  servicePrincipalId: 'x-silo-service-principal-id',
  userId: 'x-silo-user-id',
  operatorSessionId: 'x-silo-operator-session-id',
  /** A member of staff on a staff path, named by the admin portal from their portal session (D45). */
  operatorId: 'x-silo-operator-id',
  /** The person's session, resolved by the gateway; the policy service reads its MFA state. */
  sessionId: 'x-silo-session-id',
} as const;

export const CORRELATION_HEADER = 'x-correlation-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Development and tests only, without TLS: the caller names itself. */
export const DEV_CALLER_HEADER = 'x-silo-caller';
/** Development and tests only, without TLS: the caller's cell, when it is not the callee's (global-tier calls). */
export const DEV_CALLER_CELL_HEADER = 'x-silo-caller-cell';
/** Names a scenario branch. The executor and connect-runtime refuse any request carrying it (spec 39.8). */
export const SCENARIO_BRANCH_HEADER = 'x-silo-scenario-branch';

/** The body of every error response. */
export const errorBody = z.object({
  error: z.object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().min(0).optional(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    issues: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBody>;
