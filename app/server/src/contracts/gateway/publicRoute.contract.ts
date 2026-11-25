// The gateway's public routes (spec 7.3): the browser-facing API under /api/v1, as data.
// Each route names
// - the session it needs: none (sign-in, password reset, accepting an invitation); a
//   live session whose MFA may still be pending (the MFA routes, the session itself,
//   sign-out); or a complete session, MFA satisfied or not required, for everything else;
// - the permission the policy service must allow before anything is forwarded (spec
//   57.1: the gateway authorises every request). A route for a complete session must
//   name one, so no later route can forget, or say it reaches only the member's own
//   records (their notifications, their allowance), which the forwarded service scopes
//   to the membership the gateway puts in the context, or say why the forwarded service
//   decides instead: a rule the policy service cannot state as one permission, such as
//   "the connection's owner, or a permission at its owning scope" (spec 14.9). Such a
//   route still needs a complete session, and its reason is part of its declaration;
// - the internal contract it forwards to, and how its input maps onto that contract and
//   the reply back. Identity never comes from the browser: the gateway sets the request
//   context from the resolved session alone;
// - or, instead of forwarding, an answer from the resolved session.
//
// A route in an organisation's context either reads or writes. A GET reads; any other method
// writes unless it declares that it reads: it keeps nothing the organisation would miss (a
// search, a plan run, a preview, a prediction), at most the audit record of the reading, a
// cached plan, its charge or when it last ran. While the organisation's writes are paused (a
// tenant migration's window, spec 6.4: read-only from the window to the directory's move,
// so nothing is written that the export would leave behind) the session's check refuses
// every write; reads go on.
//
// A route that establishes a session (its reply carries a session token) has the
// gateway set the cookie; the token is never in a body the browser can read. A route
// that ends one has the cookie cleared.
//
// A webhook route is the one kind no browser sends: a provider's server posts to it with
// no session. Its body is taken as raw bytes, whatever the content type, and forwarded
// unparsed with the named signature header verbatim; the forwarded service verifies the
// signature over those bytes. The browser rules (Origin, x-silo-csrf, JSON bodies) do not
// apply to it, and a request carrying browser fetch metadata is refused.
//
// Declarations only: the mappings are pure functions of their input. Adding a public
// route is adding an entry here and listing it in routeTable.contract.ts.

import { z } from 'zod';
import type { SessionView } from '../auth/session.contract.ts';
import type { AnyContract, CallInput, CallOutput, HttpMethod } from '../endpoint.contract.ts';

export const API_PREFIX = '/api/v1';

export type SessionRequirement = 'none' | 'mfa_pending' | 'complete';

/** The resolved session, with the token from the cookie. */
export interface EdgeSession extends SessionView {
  readonly token: string;
}

/** Where the request came from: the address from the trusted proxy hops, the user agent. */
export interface EdgeClient {
  readonly address: string | undefined;
  readonly userAgent: string | undefined;
}

/**
 * An API client's access session (spec 60.5), from the request's bearer token: a service
 * principal, never a person. It reaches only routes for a complete session whose decision
 * the policy service makes (a permission, or the forwarded service's own rule).
 */
export interface EdgePrincipal {
  readonly sessionId: string;
  readonly organisationId: string;
  readonly servicePrincipalId: string;
  readonly expiresAt: string;
  readonly token: string;
}

export interface EdgeContext<S extends SessionRequirement = SessionRequirement> {
  /** A person's session; absent when an API client calls (then principal is set). */
  readonly session: S extends 'none' ? undefined : EdgeSession;
  readonly principal?: EdgePrincipal | undefined;
  readonly client: EdgeClient;
}

type ObjectSchema = z.ZodObject<z.ZodRawShape>;
type Empty = z.ZodObject<{}, z.core.$strict>;

export interface PublicInput<P extends ObjectSchema, Q extends ObjectSchema, B extends z.ZodType> {
  params: z.output<P>;
  query: z.output<Q>;
  body: z.output<B>;
}

export type ResourceType = 'connection' | 'silo' | 'view' | 'object_type' | 'app';

/** The decision asked of the policy service before forwarding. */
export interface PermissionCheck<I> {
  permission: string;
  /** The scope acted on, when the permission may be held on part of the tree. */
  scopeId?: (input: I) => string | undefined;
  /** The resource acted on, when the permission may be granted on it. */
  resource?: (input: I) => { type: ResourceType; id: string } | undefined;
}

interface RouteBase<S extends SessionRequirement, P extends ObjectSchema, Q extends ObjectSchema, B extends z.ZodType, R extends z.ZodType> {
  /** lowerCamelCase; logs and metrics name the route gateway.<name>. */
  name: string;
  method: HttpMethod;
  /** Under API_PREFIX, Express-style, with :name for each path parameter. */
  path: `/${string}`;
  session: S;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** Default 200, or 204 when the response is z.undefined(). */
  status?: 200 | 201 | 202 | 204;
  /** Below the forwarded contract's own bound where the body is small by nature. */
  maxBodyBytes?: number;
  permission?: PermissionCheck<PublicInput<P, Q, B>>;
  /** Instead of a permission: the route reaches only the signed-in member's own records. */
  ownRecords?: true;
  /** For an API client's server, never a browser (the token exchange): no browser rules, browser fetch metadata refused. */
  apiClient?: true;
  /**
   * Instead of a permission: why the forwarded service makes the decision itself (an
   * owner-or-permission rule, or a rule on the resource's own state). Never empty.
   */
  decidedByService?: string;
  /** A POST, PUT, PATCH or DELETE that keeps nothing the organisation would miss (see the header): open while its writes are paused. */
  reads?: true;
}

/** A provider's webhook: the raw body and one signature header, forwarded as they came. */
export interface WebhookIntake {
  /** Lower-case header name, forwarded verbatim. */
  signatureHeader: string;
  /** The largest body accepted, in bytes. */
  maxBytes: number;
}

/** The body a webhook route's call() receives: built by the edge from the request. */
export const webhookBody = z.strictObject({ payload: z.string(), signature: z.string() });

export interface ForwardingRouteDefinition<
  S extends SessionRequirement, P extends ObjectSchema, Q extends ObjectSchema, B extends z.ZodType, R extends z.ZodType,
  C extends AnyContract,
> extends RouteBase<S, P, Q, B, R> {
  forwards: C;
  call(input: PublicInput<P, Q, B>, ctx: EdgeContext<S>): CallInput<C>;
  reply(output: CallOutput<C>, ctx: EdgeContext<S>): z.input<R>;
  /** The reply carries a new session: the gateway sets the cookie from it. */
  establishes?(output: CallOutput<C>): { token: string; absoluteExpiresAt: string };
  /** The session ends with this call: the gateway clears the cookie. */
  ends?: boolean;
  /** A provider's webhook (see above). The body schema is webhookBody. */
  webhook?: WebhookIntake;
}

export interface AnsweringRouteDefinition<
  S extends SessionRequirement, P extends ObjectSchema, Q extends ObjectSchema, B extends z.ZodType, R extends z.ZodType,
> extends RouteBase<S, P, Q, B, R> {
  /** Answered by the gateway from the resolved session; nothing is forwarded. */
  answer(input: PublicInput<P, Q, B>, ctx: EdgeContext<S>): z.input<R>;
}

/** A public route as the edge holds it, its schemas erased. */
export interface PublicRoute {
  readonly id: string;
  readonly name: string;
  readonly method: HttpMethod;
  /** The full path, API_PREFIX included. */
  readonly path: string;
  readonly session: SessionRequirement;
  readonly params: ObjectSchema;
  readonly query: ObjectSchema;
  readonly body: z.ZodType;
  readonly response: z.ZodType;
  readonly status: 200 | 201 | 202 | 204;
  readonly maxBodyBytes: number | undefined;
  readonly permission: PermissionCheck<PublicInput<any, any, any>> | undefined;
  readonly ownRecords: boolean;
  /** Why the forwarded service decides, where the route names no permission. */
  readonly decidedByService: string | undefined;
  readonly webhook: WebhookIntake | undefined;
  /** Called by an API client's server, never a browser. */
  readonly apiClient: boolean;
  /** Writes in an organisation's context (see the header): refused while the organisation's writes are paused. */
  readonly writes: boolean;
  readonly forwards: AnyContract | undefined;
  readonly call: ((input: PublicInput<any, any, any>, ctx: EdgeContext) => unknown) | undefined;
  readonly reply: ((output: any, ctx: EdgeContext) => unknown) | undefined;
  readonly establishes: ((output: any) => { token: string; absoluteExpiresAt: string }) | undefined;
  readonly ends: boolean;
  readonly answer: ((input: PublicInput<any, any, any>, ctx: EdgeContext) => unknown) | undefined;
}

/**
 * A route's types, kept for its callers (the web client): what the browser sends (path
 * parameters, query and body, each only where the route takes one) and what it gets back.
 * Types only: the key is a symbol nothing sets, so a route at runtime is its PublicRoute.
 */
declare const routeTypes: unique symbol;
type Part<K extends string, S extends z.ZodType> = S extends z.ZodUndefined ? {}
  : {} extends z.input<S> ? { [key in K]?: z.input<S> } : { [key in K]: z.input<S> };
export interface TypedRoute<In, Out> {
  readonly [routeTypes]?: { readonly input: In; readonly output: Out };
}
type Typed<P extends ObjectSchema, Q extends ObjectSchema, B extends z.ZodType, R extends z.ZodType> =
  PublicRoute & TypedRoute<Part<'params', P> & Part<'query', Q> & Part<'body', B>, z.output<R>>;
/** What a caller sends a route. */
export type RouteInput<T> = T extends TypedRoute<infer In, unknown> ? In : never;
/** What a route replies. */
export type RouteOutput<T> = T extends TypedRoute<unknown, infer Out> ? Out : never;

const NAME = /^[a-z][A-Za-z0-9]{1,63}$/;
const SEGMENT = /^(?::[a-z][A-Za-z0-9]*|[a-z0-9][a-z0-9._-]*)$/;
const registry = new Map<string, PublicRoute>();

export function definePublicRoute<
  const S extends SessionRequirement, const C extends AnyContract,
  const P extends ObjectSchema = Empty, const Q extends ObjectSchema = Empty,
  const B extends z.ZodType = z.ZodUndefined, const R extends z.ZodType = z.ZodType,
>(definition: ForwardingRouteDefinition<S, P, Q, B, R, C>): Typed<P, Q, B, R>;
export function definePublicRoute<
  const S extends SessionRequirement,
  const P extends ObjectSchema = Empty, const Q extends ObjectSchema = Empty,
  const B extends z.ZodType = z.ZodUndefined, const R extends z.ZodType = z.ZodType,
>(definition: AnsweringRouteDefinition<S, P, Q, B, R>): Typed<P, Q, B, R>;
export function definePublicRoute(
  definition: ForwardingRouteDefinition<SessionRequirement, ObjectSchema, ObjectSchema, z.ZodType, z.ZodType, AnyContract>
    | AnsweringRouteDefinition<SessionRequirement, ObjectSchema, ObjectSchema, z.ZodType, z.ZodType>,
): PublicRoute {
  const id = `gateway.${definition.name}`;
  const where = `public route ${id}`;
  if (!NAME.test(definition.name)) throw new TypeError(`${where}: the name is lowerCamelCase`);
  if (registry.has(id)) throw new TypeError(`${where} is already defined`);
  const segments = definition.path.split('/').slice(1);
  if (segments.some((s) => !SEGMENT.test(s))) throw new TypeError(`${where}: each path segment is lowercase text or a :parameter`);
  const pathParams = segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
  const params = definition.params ?? z.strictObject({});
  if (Object.keys(params.shape).sort().join(',') !== [...pathParams].sort().join(',')) {
    throw new TypeError(`${where}: the params schema must name exactly the path parameters (${pathParams.join(', ') || 'none'})`);
  }
  const path = `${API_PREFIX}${definition.path}`;
  for (const existing of registry.values()) {
    if (existing.method === definition.method && existing.path.replace(/:[^/]+/g, ':') === path.replace(/:[^/]+/g, ':')) {
      throw new TypeError(`${where}: ${definition.method} ${path} is already ${existing.id}`);
    }
  }
  if (definition.method === 'GET' && definition.body !== undefined) throw new TypeError(`${where}: a GET has no body`);
  const decides = definition.decidedByService;
  if (definition.session === 'complete' && definition.permission === undefined && definition.ownRecords !== true && decides === undefined) {
    throw new TypeError(`${where}: a route for a complete session names the permission it needs (spec 57.1)`);
  }
  if (decides !== undefined) {
    if (decides.trim().length < 20) throw new TypeError(`${where}: say why the service decides`);
    if (definition.permission !== undefined || definition.ownRecords === true) {
      throw new TypeError(`${where}: a route names a permission, reaches its own records, or lets the service decide: one of them`);
    }
    if (definition.session !== 'complete') throw new TypeError(`${where}: a service decides for a member with a complete session`);
    if (!('forwards' in definition) || definition.forwards.context === 'none') {
      throw new TypeError(`${where}: the deciding service needs the member's context`);
    }
  }
  if (definition.ownRecords === true) {
    if (definition.permission !== undefined) throw new TypeError(`${where}: a route names a permission or reaches its own records, not both`);
    if (definition.session !== 'complete') throw new TypeError(`${where}: own records belong to a member with a complete session`);
    if (!('forwards' in definition) || definition.forwards.context !== 'organisation') {
      throw new TypeError(`${where}: own records are scoped by the membership in an organisation context`);
    }
  }
  if (definition.apiClient === true && (definition.session !== 'none' || ('forwards' in definition && definition.webhook !== undefined))) {
    throw new TypeError(`${where}: an API client's route takes no session and is not a webhook`);
  }
  if (definition.permission !== undefined && definition.session === 'none') {
    throw new TypeError(`${where}: a permission is decided for a member, so the route needs a session`);
  }
  const forwarding = 'forwards' in definition;
  if (forwarding === ('answer' in definition)) throw new TypeError(`${where}: a route either forwards or answers`);
  if (!forwarding && definition.session === 'none') throw new TypeError(`${where}: an answer comes from the session`);
  if (forwarding) {
    const contract = definition.forwards;
    if (!contract.callers.includes('gateway')) throw new TypeError(`${where}: the gateway is not a listed caller of ${contract.id}`);
    if (contract.context !== 'none' && definition.session === 'none') {
      throw new TypeError(`${where}: ${contract.id} needs ${contract.context} context, which only a session gives`);
    }
    if (contract.idempotency === 'keyed' && definition.method === 'GET') {
      throw new TypeError(`${where}: a keyed operation is not reached by GET`);
    }
    if ((definition.establishes !== undefined) && definition.ends === true) {
      throw new TypeError(`${where}: a route establishes a session or ends one, not both`);
    }
    if (definition.webhook !== undefined) {
      if (definition.session !== 'none' || definition.method !== 'POST') throw new TypeError(`${where}: a webhook is a POST with no session`);
      if (definition.body !== webhookBody) throw new TypeError(`${where}: a webhook's body is webhookBody, built by the edge`);
      if (!/^[a-z0-9-]{1,64}$/.test(definition.webhook.signatureHeader)) throw new TypeError(`${where}: the signature header is a lower-case name`);
      if (!Number.isInteger(definition.webhook.maxBytes) || definition.webhook.maxBytes < 1) throw new TypeError(`${where}: maxBytes is a positive integer`);
    }
  }
  if (definition.reads === true && (definition.method === 'GET' || !forwarding || definition.forwards.context !== 'organisation')) {
    throw new TypeError(`${where}: only a POST, PUT, PATCH or DELETE in an organisation's context says it reads; a GET always does`);
  }
  const response = definition.response;
  const status = definition.status ?? (response instanceof z.ZodUndefined ? 204 : 200);
  if ((status === 204) !== (response instanceof z.ZodUndefined)) {
    throw new TypeError(`${where}: status 204 exactly when the response is z.undefined()`);
  }

  const route: PublicRoute = {
    id,
    name: definition.name,
    method: definition.method,
    path,
    session: definition.session,
    params,
    query: definition.query ?? z.strictObject({}),
    body: definition.body ?? z.undefined(),
    response,
    status,
    maxBodyBytes: definition.maxBodyBytes,
    permission: definition.permission as PublicRoute['permission'],
    ownRecords: definition.ownRecords === true,
    decidedByService: decides,
    webhook: forwarding ? definition.webhook : undefined,
    apiClient: definition.apiClient === true,
    writes: forwarding && definition.forwards.context === 'organisation' && definition.method !== 'GET' && definition.reads !== true,
    forwards: forwarding ? definition.forwards : undefined,
    call: forwarding ? definition.call as PublicRoute['call'] : undefined,
    reply: forwarding ? definition.reply as PublicRoute['reply'] : undefined,
    establishes: forwarding ? definition.establishes as PublicRoute['establishes'] : undefined,
    ends: forwarding ? definition.ends === true : false,
    answer: forwarding ? undefined : definition.answer as PublicRoute['answer'],
  };
  registry.set(id, route);
  return route;
}

/** Every public route defined in this process. */
export function definedPublicRoutes(): readonly PublicRoute[] {
  return [...registry.values()];
}
