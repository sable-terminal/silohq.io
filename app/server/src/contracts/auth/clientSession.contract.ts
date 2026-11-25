// API clients (spec 60.4, 60.5): a service principal of kind api_client exchanges its secret
// for a short-lived opaque access session, which it then sends as a bearer token. The
// gateway resolves the session on every request and acts as the principal: never as a
// person, never on a person's session routes, and only where the policy service decides
// (spec 60.6: the principal executes, never authorises).
//
// The access session is an iam.sessions row like any other (service_principal_id set,
// auth_method agent), checked in Postgres on each request, so revoking the principal or
// the session takes effect on the next one.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { client, sessionToken } from './session.contract.ts';

/** How long an access session lasts at most; never past the client's own expiry. */
export const CLIENT_SESSION_MINUTES = 15;

export const issueClientSession = defineContract({
  service: 'auth', name: 'issueClientSession', method: 'POST', path: '/v1/client-sessions', callers: ['gateway'],
  // Each call issues a new session; a retried exchange leaves an extra one that expires.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationId: z.uuid(),
    /** The service principal's id. */
    clientId: z.uuid(),
    clientSecret: z.string().regex(/^silo_api_[A-Za-z0-9_-]{43}$/, 'must be an API client secret'),
    client: client.optional(),
  }),
  response: z.object({ accessToken: sessionToken, tokenType: z.literal('Bearer'), expiresAt: z.string() }),
  status: 201,
  maxBodyBytes: 2048,
});

export const clientSessionView = z.object({
  sessionId: z.uuid(),
  organisationId: z.uuid(),
  servicePrincipalId: z.uuid(),
  expiresAt: z.string(),
});
export type ClientSessionView = z.infer<typeof clientSessionView>;

export const resolveClientSession = defineContract({
  service: 'auth', name: 'resolveClientSession', method: 'POST', path: '/v1/client-sessions/resolve', callers: ['gateway'],
  // Read-only: an access session has no idle clock.
  shed: 'session_auth', context: 'none', idempotency: 'none',
  /** writes: as resolveSession's (refused while the organisation's writes are paused). */
  body: z.strictObject({ accessToken: sessionToken, writes: z.boolean().optional() }),
  response: clientSessionView,
  maxBodyBytes: 1024,
});
