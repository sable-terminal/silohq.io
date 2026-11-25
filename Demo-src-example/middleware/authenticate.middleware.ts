import type { NextFunction, Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { authConfig } from '../config/auth.config';
import { denial, unauthenticated } from '../utils/error.util';
import { runWithTenant } from '../utils/tenantContext.util';

/**
 * Turning a token into a tenant.
 *
 * THIS IS WHERE TENANT CONTEXT IS ESTABLISHED FOR THE REQUEST, and after it runs
 * every statement any handler executes is scoped to one organisation by the
 * database itself. `db.infra` refuses to execute without it, so an endpoint that
 * forgets this middleware does not leak — it fails, loudly, on its first query.
 * That is the intended failure mode: a missing authorisation check should break
 * the endpoint rather than widen it.
 *
 * THE CONTEXT IS ENTERED AROUND `next()`, NOT AWAITED. `AsyncLocalStorage`
 * propagates to everything reached synchronously from inside `run`, and Express
 * enters the next layer synchronously — so the whole downstream chain, including
 * every `await` inside it, sees the store. Awaiting the returned promise instead
 * would mean waiting for the entire response before this middleware returned,
 * which is not what `next()` means.
 */

/** Bearer header first, session cookie second. */
export function tokenFrom(req: Request): string | null {
  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }

  /*
   * PARSED HERE RATHER THAN WITH A COOKIE MIDDLEWARE. One cookie is read in the
   * whole application and it is this one; adding a dependency that parses every
   * cookie on every request, to reach a single known name, is a larger surface
   * than the six lines it saves.
   */
  const cookies = req.headers.cookie;
  if (!cookies) return null;

  for (const pair of cookies.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== authConfig.cookie.name) continue;
    const value = decodeURIComponent(pair.slice(eq + 1).trim());
    return value || null;
  }

  return null;
}

/**
 * Require a fully resolved session: a user, an active membership, an
 * organisation. Everything after this may read `req.auth`.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = tokenFrom(req);
  if (!token) {
    next(unauthenticated());
    return;
  }

  const auth = await authService.authenticate(token);
  if (!auth) {
    /*
     * ONE ANSWER FOR EVERY FAILURE. Expired, revoked, unknown, belongs to a
     * suspended user, names a membership that was removed — all indistinguishable
     * from here. Reporting which would tell an attacker holding a stolen token
     * whether it was ever valid.
     */
    next(unauthenticated());
    return;
  }

  /*
   * MFA IS CHECKED HERE, NOT PER ENDPOINT. An organisation that requires it
   * requires it for everything; leaving the check to individual routes means the
   * one route nobody remembered is the way around the policy.
   */
  if (auth.organisation.mfaRequired && !auth.session.mfaSatisfiedAt) {
    next(
      denial({
        message: 'This organisation requires two-factor authentication. Confirm a code to continue.',
        code: 'denial.mfa_required',
      }),
    );
    return;
  }

  req.auth = auth;

  runWithTenant(
    {
      organisationId: auth.organisation.id,
      membershipId: auth.membership.id,
      userId: auth.user.id,
    },
    async () => {
      next();
    },
  ).catch((error: unknown) => {
    // Express catches what handlers throw, so reaching here means the store
    // itself failed. Logged rather than swallowed; the response is already the
    // error handler's problem by now.
    req.log.error({ err: error }, 'Tenant scope failed');
  });
}

/**
 * A token, if one was sent, and no session resolution.
 *
 * FOR THE ENDPOINTS THAT ACT ON A SESSION WITHOUT ONE BEING USABLE YET — logging
 * out, choosing an organisation after a login that returned several, satisfying
 * MFA. `requireAuth` would reject all three: none of them has an active
 * membership on the session, which is exactly what they are there to establish.
 */
export function requireToken(req: Request, _res: Response, next: NextFunction): void {
  if (!tokenFrom(req)) {
    next(unauthenticated());
    return;
  }
  next();
}

/**
 * The session token as a handler sees it.
 *
 * THROWS RATHER THAN RETURNING NULL, for the same reason `requireTenant` does:
 * a handler that reached this line without `requireToken` in front of it is
 * mis-wired, and returning null would let it carry on with `undefined` and fail
 * somewhere less obvious.
 */
export function tokenOf(req: Request): string {
  const token = tokenFrom(req);
  if (!token) throw unauthenticated();
  return token;
}
