// Invitations (spec 55.6): an admin invites a person by email with a role and, usually, a
// scope; the person accepts with a single-use link (7 days by default). Acceptance
// creates the membership, the role assignment and the scope membership in one
// transaction, under the delegation rules (spec 56.7), and signs the person in.

import { z } from 'zod';
import { MAX_PASSWORD_LENGTH } from '../../utils/password.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { client, sessionToken, sessionView } from './session.contract.ts';

export const createInvitation = defineContract({
  service: 'auth', name: 'createInvitation', method: 'POST', path: '/v1/invitations', callers: ['gateway'],
  // The inviter's request: organisation, membership and session, so policy can decide.
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    email: z.email().max(320),
    roleId: z.uuid(),
    /** The scope the person joins and the role applies on. Absent: organisation-wide, super admins only. */
    scopeId: z.uuid().optional(),
  }),
  response: z.object({ invitationId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) }),
  status: 201,
  maxBodyBytes: 2048,
});

export const acceptInvitation = defineContract({
  service: 'auth', name: 'acceptInvitation', method: 'POST', path: '/v1/invitations/accept', callers: ['gateway'],
  // The link is single use, so a retry after success fails rather than repeats.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    organisationSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    token: z.string().regex(/^silo_inv_[A-Za-z0-9_-]{43}$/, 'must be an invitation token'),
    /** A new person's chosen password, or an existing person's current one, which proves the account is theirs. */
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    client: client.optional(),
  }),
  response: sessionView.extend({ sessionToken }),
  status: 201,
  maxBodyBytes: 4096,
});
