// The resolution service's audit events (spec 23, 24.8, 77). They travel as the audit
// service's audit_event (contracts/audit/auditEvent.contract.ts), whose catalogue lists
// these names. References, counts and closed codes only: never a key, an identifier or a
// value, hashed or clear.

export const RESOLUTION_EVENTS = [
  // Spec 23
  'resolution_proposed', 'resolution_confirmed', 'resolution_rejected', 'object_split', 'match_key_remapped', 'authority_declared',
  'authority_revoked', 'dispute_recheck_unavailable',
  // Spec 24.8
  'object_merged_redirect',
  // A resolution run over a type's contributing objects (index and analysis)
  'resolution_run_started', 'resolution_run_completed',
] as const;
export type ResolutionEventName = (typeof RESOLUTION_EVENTS)[number];
