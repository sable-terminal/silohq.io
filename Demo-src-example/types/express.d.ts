import type { AuthenticatedRequest } from '../services/auth.service';
import type { Authority } from '../services/authorisation.service';
import type { PrincipalRequest } from '../services/principal.service';
import type { Logger } from 'pino';

/**
 * What a request carries once the middleware has run.
 *
 * DECLARED, NOT CAST. The alternative is `(req as any).auth` at every use, which
 * compiles everywhere including the handlers that forgot to require
 * authentication — and a handler that reads `req.auth` without the middleware
 * that sets it is an endpoint serving a tenant's data to nobody in particular.
 * Declaring it means the compiler knows the shape; the middleware below is what
 * makes it true at runtime.
 *
 * OPTIONAL, ON PURPOSE. Marking these required would let an unauthenticated
 * handler read `req.auth.organisation.id` and typecheck. The `?` forces every
 * reader to either narrow or go through `actorOf`, which throws.
 */
declare global {
  namespace Express {
    interface Request {
      /** Set by `requestContext`. Present on every request. */
      id: string;
      log: Logger;
      /** Set by `requireAuth`. A resolved session with an active membership. */
      auth?: AuthenticatedRequest;
      /** Cached by `loadAuthority`. One authority load per request, at most. */
      authority?: Authority;
      /**
       * Set by `requireApiKey`. A machine identity, with no user and no session.
       *
       * DELIBERATELY NOT `auth`. A principal has no membership, so anything
       * reading `req.auth.membership.id` would be reading a person who does not
       * exist — and making it optional-but-shaped-the-same is how a handler ends
       * up attributing an automation's action to whoever created it.
       */
      principal?: PrincipalRequest;
      /** Set by `validate`. Never `req.query`, which Express 5 makes read-only. */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
