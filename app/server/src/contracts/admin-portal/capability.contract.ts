// What Silo staff may do in the admin portal (spec 7 catalogue, 11.6, 13, 71). Staff roles
// live in the staff identity provider (13.4: "reviewed quarterly and removed on
// departure"); its groups claim maps to these capabilities (ADMIN_PORTAL_GROUP_CAPABILITIES).
// Where the spec names a staff permission, the capability carries its name.
//
// No capability approves an Action, unwraps a customer credential or reads a record value
// outside a break-glass session (13.3, 13.4).

export { STAFF_CAPABILITIES, type StaffCapability } from '../../config/adminPortal.config.ts';

// ----------------------------------------------------------------------------- break-glass

export const ACCESS_PURPOSES = ['support_request', 'incident_response', 'legal_obligation', 'security_investigation'] as const;
export type AccessPurpose = (typeof ACCESS_PURPOSES)[number];

/** In order: each level includes the ones before it. */
export const ACCESS_LEVELS = ['metadata_read', 'tenant_read', 'tenant_act'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Whether a session at `held` covers what `needed` asks. */
export const levelCovers = (held: AccessLevel, needed: AccessLevel): boolean => ACCESS_LEVELS.indexOf(held) >= ACCESS_LEVELS.indexOf(needed);

export const ACCESS_STATUSES = ['requested', 'approved', 'denied', 'active', 'ended', 'expired', 'cancelled'] as const;

/** Spec 13.3: "Maximum 4 hours." */
export const MAX_SESSION_MINUTES = 240;

/** Spec 13.3: "terminal sessions are recorded and kept 12 months." */
export const RECORDING_RETENTION_MONTHS = 12;
