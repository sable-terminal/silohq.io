// The cell's synthetic organisation (spec 11.2; decision 2026-11-18): Silo's own, in every cell,
// where the Fleet agent's release gates run their question, subscription, Action and revert
// tests as a customer would. auth makes it once, at the agent's asking, with two members, each
// a Super admin, so one proposes and the other approves as two people do. Neither ever signs
// in: auth mints their sessions for the Fleet agent alone, over mutual TLS, so no password or
// secret exists to keep. No customer data; never in the directory; no billing.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { sessionToken } from './session.contract.ts';

export const SYNTHETIC_MEMBERS = ['proposer', 'approver'] as const;
export type SyntheticMember = (typeof SYNTHETIC_MEMBERS)[number];
/** How long a minted session lasts: one round of the tests. */
export const SYNTHETIC_SESSION_MINUTES = 30;

export const provisionSyntheticTenant = defineContract({
  service: 'auth', name: 'provisionSyntheticTenant', method: 'PUT', path: '/v1/synthetic-tenant', callers: ['fleet-control'],
  // Made once; asking again returns it.
  context: 'none', idempotency: 'none',
  response: z.object({
    organisationId: z.uuid(), slug: z.string(),
    members: z.object({ proposer: z.uuid(), approver: z.uuid() }),
    created: z.boolean(),
  }),
});

export const issueSyntheticSession = defineContract({
  service: 'auth', name: 'issueSyntheticSession', method: 'POST', path: '/v1/synthetic-tenant/sessions', callers: ['fleet-control'],
  // Each call issues a new session; one left over expires.
  context: 'none', idempotency: 'none',
  body: z.strictObject({ member: z.enum(SYNTHETIC_MEMBERS) }),
  response: z.object({ sessionToken, organisationId: z.uuid(), membershipId: z.uuid(), expiresAt: z.string() }),
  maxBodyBytes: 256,
});
