// The auth events of spec 55.8, as they cross from auth to the audit ledger: written to
// the outbox in the transaction that made the change, published on bus-durable topic
// audit.events by the outbox relay, and stored in audit.auth_events by the audit service.
// References and counts only, never a value: no email, no address (a keyed hash), no
// password or code.

import { z } from 'zod';

export const AUTH_EVENTS = [
  'login', 'login_failed', 'lockout', 'password_changed', 'password_reset_requested', 'password_reset_consumed',
  'mfa_enrolled', 'mfa_satisfied', 'member_invited', 'member_joined',
  // Federation and provisioning (spec 55.8)
  'provider_configured', 'scim_token_issued', 'scim_token_revoked', 'member_suspended', 'member_reinstated',
  // Sessions (spec 60.8): an API client's access session; a switch of active membership, in each organisation.
  'session_issued', 'membership_switched',
  // A factor removed by its owner (not named by the spec; a factor's removal weakens the account, so it is recorded).
  'mfa_factor_removed',
  // A sign-in identity unlinked by its owner (decision 2026-11-14: every unlink is audited).
  'identity_unlinked',
  // SCIM groups (decision 2026-11-14): a group changed by the identity provider, with the grants it
  // reconciled; an admin's mapping of a group to a role created or removed.
  'scim_group_changed', 'scim_group_mapping_created', 'scim_group_mapping_removed',
  // An organisation created by self-serve sign-up, in that organisation (decision 2026-11-14).
  'organisation_signed_up',
  // An email domain added, verified (claimed in the cell) or removed (decision 2026-11-14).
  'domain_added', 'domain_verified', 'domain_removed',
  // Single logout with a SAML provider (spec 55.5): who started it and how many sessions it ended.
  'single_logout',
] as const;

export const authEventMessage = {
  topic: 'audit.events',
  name: 'auth_event',
  version: 1,
  schema: z.strictObject({
    event: z.enum(AUTH_EVENTS),
    userId: z.uuid().nullable(),
    membershipId: z.uuid().nullable(),
    /** Keyed hash of the client address, hex. */
    ipHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** Closed-set reasons and counts only. */
    detail: z.record(z.string().regex(/^[a-z][a-z_]*$/), z.union([z.string().max(64), z.number(), z.boolean()])),
  }),
} as const;

export type AuthEvent = z.infer<typeof authEventMessage.schema>;
