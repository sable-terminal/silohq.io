import { env } from './env.config';
import {
  LOCKOUT_SECONDS,
  MAX_FAILED_ATTEMPTS,
  SESSION_CACHE_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from './constants.config';

/**
 * Authentication settings, assembled from the environment and the constants.
 *
 * THE SECRETS ARE READ ONCE, HERE. A module reaching into `process.env` for a
 * secret at the point of use is a module that can be given a different one by a
 * later import, and it is invisible to the boot-time validation that is supposed
 * to catch a missing value before the server binds.
 */

export const authConfig = {
  sessionTtlSeconds: SESSION_TTL_SECONDS,
  sessionCacheTtlSeconds: SESSION_CACHE_TTL_SECONDS,
  maxFailedAttempts: MAX_FAILED_ATTEMPTS,
  lockoutSeconds: LOCKOUT_SECONDS,

  sessionSecret: env.SESSION_SECRET,

  /**
   * Falls back to the session secret when unset.
   *
   * ACCEPTABLE IN DEVELOPMENT AND REFUSED IN PRODUCTION by
   * `assertProductionReady`. The fallback exists so a developer is not blocked
   * by a second secret; sharing them in production would mean a routine session
   * rotation silently breaks the linkability of every historical audit row.
   */
  ipHashSecret: env.IP_HASH_SECRET ?? env.SESSION_SECRET,

  cookie: {
    name: 'silo_session',
    /**
     * `lax`, NOT `strict`. Strict means a session cookie is withheld on any
     * cross-site navigation — so following an invitation link from an email
     * arrives logged out, every time, and the user is told their invitation is
     * invalid. `lax` sends it on a top-level GET and withholds it on the
     * cross-site POST that CSRF actually needs.
     */
    sameSite: 'lax' as const,
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    path: '/',
    /*
     * Undefined locally, `.silohq.io` in production. See `COOKIE_DOMAIN` — the
     * API and the app are the same host in development and different subdomains
     * in production, and only the second case needs a domain to cross.
     */
    domain: env.COOKIE_DOMAIN,
  },
} as const;
