// What the edge does for a public route once the request is admitted (spec 7.3, 57.1,
// 60.3): resolve the session through the auth service, hold an MFA-pending session to
// the MFA routes, ask the policy service for the route's permission, and forward to the
// internal contract with the request context taken from the session alone. The browser
// can send any header it likes; none of them becomes identity.
//
// Idempotency keys: a keyed route needs the browser's Idempotency-Key, forwarded under
// the membership (<membershipId>.<key>), so two members cannot collide on a key, and
// one member cannot replay another's result by guessing theirs.

import { resolveSession, revokeSession, sessionToken as sessionTokenSchema } from '../../contracts/auth/session.contract.ts';
import type { AnyContract } from '../../contracts/endpoint.contract.ts';
import { resolveClientSession } from '../../contracts/auth/clientSession.contract.ts';
import type { EdgeContext, EdgePrincipal, EdgeSession, PublicInput, PublicRoute } from '../../contracts/gateway/publicRoute.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { SessionEvent } from '../../utils/session.util.ts';

/** MFA states under which a session reaches only the MFA routes (spec 55.4). */
export const MFA_PENDING: ReadonlySet<string> = new Set(['required', 'enrolment_required']);

const CLIENT_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export interface CallMeta {
  correlationId: string;
  signal?: AbortSignal;
}

export const sessionRequired = (): AppError =>
  new AppError('unauthenticated', 'sign in first', { code: 'gateway.session_required' });

/**
 * The session behind a token. Auth refuses an unknown, revoked or expired one (auth.session_invalid),
 * and, for a request that writes, one whose organisation's writes are paused (tenant_migrations.writes_paused).
 */
export async function resolveEdgeSession(services: ServiceClient, token: string, activity: SessionEvent, meta: CallMeta & { writes?: boolean })
  : Promise<EdgeSession> {
  const view = await services.call(resolveSession, { body: { sessionToken: token, activity, ...(meta.writes === true ? { writes: true } : {}) } }, {
    correlationId: meta.correlationId, ...(meta.signal ? { signal: meta.signal } : {}),
  });
  return { ...view, token };
}

/** An API client's access session behind a bearer token. Auth refuses an unknown, revoked or expired one, or a revoked client's; a write as the session's. */
export async function resolveEdgePrincipal(services: ServiceClient, token: string, meta: CallMeta & { writes?: boolean }): Promise<EdgePrincipal> {
  const view = await services.call(resolveClientSession, { body: { accessToken: token, ...(meta.writes === true ? { writes: true } : {}) } }, {
    correlationId: meta.correlationId, ...(meta.signal ? { signal: meta.signal } : {}),
  });
  return { ...view, token };
}

/** Refuses an MFA-pending session on a route that needs a complete one. */
export function requireComplete(session: EdgeSession): void {
  if (MFA_PENDING.has(session.mfa)) {
    throw new AppError('forbidden', 'verify your second factor first', { code: 'gateway.mfa_required', details: { mfa: session.mfa } });
  }
}

/** The request context a contract receives: from the session, and only what the contract runs in. */
export function contextFor(contract: AnyContract, session: EdgeSession | EdgePrincipal | undefined): RequestContext {
  if (session === undefined || contract.context === 'none') return {};
  if ('servicePrincipalId' in session) {
    // An API client acts as its service principal (spec 60.5): never as a person, so never in a user's context.
    if (contract.context === 'user') {
      throw new AppError('forbidden', 'an API client cannot use this route: it acts for a signed-in person', { code: 'gateway.member_required' });
    }
    return { organisationId: session.organisationId, servicePrincipalId: session.servicePrincipalId };
  }
  if (contract.context === 'user') return { userId: session.userId, sessionId: session.sessionId };
  return { organisationId: session.organisationId, membershipId: session.membershipId, userId: session.userId, sessionId: session.sessionId };
}

/** Spec 57.1: the policy service decides; deny wins. */
export async function authoriseRoute(services: ServiceClient, route: PublicRoute, input: PublicInput<any, any, any>,
  session: EdgeSession | EdgePrincipal, meta: CallMeta): Promise<void> {
  const check = route.permission;
  if (check === undefined) return;
  const scopeId = check.scopeId?.(input);
  const resource = check.resource?.(input);
  const decision = await services.call(authorise, {
    body: { permission: check.permission, ...(scopeId === undefined ? {} : { scopeId }), ...(resource === undefined ? {} : { resource }) },
  }, { request: contextFor(authorise, session), correlationId: meta.correlationId, ...(meta.signal ? { signal: meta.signal } : {}) });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', 'you do not have permission to do that', {
      code: 'gateway.not_permitted', details: { permission: check.permission, reason: decision.reason },
    });
  }
}

export interface Forwarded {
  body: unknown;
  /** A session the reply established, for the cookie. */
  established: { token: string; absoluteExpiresAt: string } | undefined;
}

export async function forwardRoute(services: ServiceClient, route: PublicRoute, input: PublicInput<any, any, any>, ctx: EdgeContext,
  meta: CallMeta & { idempotencyKey: string | undefined }): Promise<Forwarded> {
  if (route.answer !== undefined) return { body: route.answer(input, ctx), established: undefined };
  const contract = route.forwards!;
  let idempotencyKey: string | undefined;
  if (contract.idempotency === 'keyed') {
    if (meta.idempotencyKey === undefined || !CLIENT_IDEMPOTENCY_KEY.test(meta.idempotencyKey)) {
      throw new AppError('validation', 'send an Idempotency-Key header of 16 to 128 letters, digits, dashes or underscores', {
        code: 'idempotency.key_missing',
      });
    }
    // Under the membership, or the principal: two callers never collide on a key.
    const holder = (ctx.session as EdgeSession | undefined)?.membershipId ?? ctx.principal?.servicePrincipalId;
    idempotencyKey = `${holder}.${meta.idempotencyKey}`;
  }
  const output = await services.call(contract, route.call!(input, ctx) as never, {
    request: contextFor(contract, (ctx.session as EdgeSession | undefined) ?? ctx.principal), correlationId: meta.correlationId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(meta.signal ? { signal: meta.signal } : {}),
  });
  return { body: route.reply!(output, ctx), established: route.establishes?.(output) };
}

/** Signing in again on the same browser ends the session it held. Best effort. */
export function endReplacedSession(services: ServiceClient, previous: string | undefined, established: string, meta: CallMeta): void {
  if (previous === undefined || previous === established || !sessionTokenSchema.safeParse(previous).success) return;
  void services.call(revokeSession, { body: { sessionToken: previous } }, { correlationId: meta.correlationId }).catch(() => undefined);
}
