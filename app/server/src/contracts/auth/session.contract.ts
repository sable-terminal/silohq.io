// The auth service's endpoints for the gateway (spec 55, 60). The gateway holds the
// browser's session token (a cookie) and passes it in the body; nothing here trusts
// identity headers, because these calls establish identity.
//
// Password login is per organisation: the session is bound to one membership (spec
// 60.2), and the organisation's own rules (SSO required, MFA required, shorter session
// timeouts) apply from the first request.

import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../utils/password.util.ts';
import { SESSION_ACTIVITY } from '../../utils/session.util.ts';
import { defineContract } from '../endpoint.contract.ts';

export const sessionToken = z.string().regex(/^silo_ses_[A-Za-z0-9_-]{86}$/, 'must be a session token');
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const email = z.email().max(320);
const timestamp = z.iso.datetime({ offset: true });

/** Where the request came from, for rate limits and keyed hashes. Never stored in clear. */
export const client = z.strictObject({
  address: z.union([z.ipv4(), z.ipv6()]).optional(),
  userAgent: z.string().max(1024).optional(),
});

/**
 * What the session may do about MFA (spec 55.4): satisfied; required (a factor is enrolled
 * and not yet verified); enrolment_required (the organisation requires MFA and the person
 * has no factor); not_required. Until it is satisfied or not_required, the gateway allows
 * only the MFA endpoints and the policy service denies everything else.
 */
export const mfaState = z.enum(['satisfied', 'required', 'enrolment_required', 'not_required']);
export type MfaState = z.infer<typeof mfaState>;

export const sessionView = z.object({
  sessionId: z.uuid(),
  userId: z.uuid(),
  organisationId: z.uuid(),
  membershipId: z.uuid(),
  /** synthetic: a member of the cell's synthetic organisation, minted for the Fleet agent's release tests (spec 11.2). */
  authMethod: z.enum(['password', 'sso', 'synthetic']),
  mfa: mfaState,
  idleExpiresAt: timestamp,
  absoluteExpiresAt: timestamp,
});
export type SessionView = z.infer<typeof sessionView>;

export const login = defineContract({
  service: 'auth', name: 'login', method: 'POST', path: '/v1/logins', callers: ['gateway'],
  // Each call issues a new session; a retried login leaves an extra session that expires.
  shed: 'session_auth', context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationSlug: slug,
    email,
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    client: client.optional(),
  }),
  response: sessionView.extend({ sessionToken }),
  status: 201,
  maxBodyBytes: 8192,
});

export const resolveSession = defineContract({
  service: 'auth', name: 'resolveSession', method: 'POST', path: '/v1/sessions/resolve', callers: ['gateway'],
  // Read-only except for the idle clock, which only what the person does moves.
  shed: 'session_auth', context: 'none', idempotency: 'none',
  body: z.strictObject({
    sessionToken,
    activity: z.enum(Object.keys(SESSION_ACTIVITY) as [keyof typeof SESSION_ACTIVITY, ...(keyof typeof SESSION_ACTIVITY)[]]),
    /**
     * The request writes in the organisation (publicRoute.contract.ts): refused while its writes
     * are paused, a tenant migration's window (spec 6.4), as tenant_migrations.writes_paused.
     */
    writes: z.boolean().optional(),
  }),
  response: sessionView,
  maxBodyBytes: 1024,
});

export const revokeSession = defineContract({
  service: 'auth', name: 'revokeSession', method: 'POST', path: '/v1/sessions/revoke', callers: ['gateway'],
  // Revoking a revoked session changes nothing.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.undefined(),
  maxBodyBytes: 1024,
});

/**
 * Switching the active membership (spec 60.2): a new session in the other organisation; the
 * one it replaces is revoked. Nothing is mutated in place.
 */
export const switchMembership = defineContract({
  service: 'auth', name: 'switchMembership', method: 'POST', path: '/v1/sessions/switches', callers: ['gateway'],
  // Each call issues a new session; the old one is revoked by the first.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken, organisationId: z.uuid(), client: client.optional() }),
  response: sessionView.extend({ sessionToken }),
  status: 201,
  maxBodyBytes: 2048,
});

/** The organisations the signed-in person belongs to in this cell, for choosing one. */
/** The signed-in person as the browser shows them (the identity menu): their own name and email. */
export const readOwnProfile = defineContract({
  service: 'auth', name: 'readOwnProfile', method: 'POST', path: '/v1/sessions/profile', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.object({ userId: z.uuid(), firstName: z.string(), lastName: z.string(), email: z.string() }),
  maxBodyBytes: 1024,
});

export const listMyMemberships = defineContract({
  service: 'auth', name: 'listMyMemberships', method: 'POST', path: '/v1/sessions/memberships', callers: ['gateway'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ sessionToken }),
  response: z.object({
    memberships: z.array(z.object({
      membershipId: z.uuid(), organisationId: z.uuid(), organisationName: z.string(), organisationSlug: z.string(),
      status: z.enum(['invited', 'active']), current: z.boolean(),
    })),
  }),
  maxBodyBytes: 1024,
});
