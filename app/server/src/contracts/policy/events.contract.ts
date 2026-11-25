// The audit events the policy service raises (spec 55.8, 56.12, 57.11, 58.11, 60.8), as
// audit_event messages through the outbox. They go to audit.audit_events rather than
// audit.auth_events because each names the scope and resource it concerns, so a scope
// admin reading their subtree's audit (spec 63.5) sees the administration done there.
// References and counts only.

/** Administration, authorisation and governance events: standard retention. */
export const POLICY_EVENTS = [
  // Membership (spec 55.7, 55.8, 56.8)
  'member_suspended', 'member_removed', 'member_reinstated', 'grants_silenced', 'grants_restored',
  'membership_suspended_with_active_grants', 'session_revoked',
  // On removal (55.7, 55.8; D207): each Cron they authored paused for reassignment; each purpose definition they answered for transferred.
  'cron_paused_on_removal', 'object_ownership_transferred',
  // Scopes and delegation (spec 56.12)
  'scope_type_created', 'scope_created', 'scope_renamed', 'scope_moved', 'scope_archived', 'scope_membership_added',
  'scope_membership_removed', 'admin_delegated', 'admin_revoked', 'grant_orphaned', 'grant_revoked_by_other_admin',
  // Roles (spec 57.11; role definition is named here, the spec lists no event for it)
  'role_defined', 'role_changed', 'role_retired', 'role_granted', 'role_revoked', 'field_policy_changed',
  // Markings, clearances and purposes (spec 58.11)
  'clearance_granted', 'clearance_revoked', 'marking_created', 'marking_retired', 'resource_marking_changed',
  'object_type_marking_changed', 'purpose_defined', 'purpose_approved', 'purpose_suspended', 'purpose_retired',
  'purpose_eligibility_granted', 'purpose_eligibility_revoked', 'purpose_session_declared', 'purpose_session_ended',
  // Decision 2026-11-14 (D81): a declaration approved; a declassifier named, approved, revoked.
  'purpose_session_approved', 'declassifier_granted', 'declassifier_approved', 'declassifier_revoked',
  'purpose_session_expired',
  // Declassification (spec 58.9, 58.11)
  'marking_declassification_requested', 'marking_declassified', 'marking_declassification_reverted',
  // Service principals (spec 60.8)
  'service_principal_created', 'service_principal_role_granted', 'service_principal_role_removed', 'service_principal_revoked',
  'service_principal_expired',
  'principal_authorising_permission_refused',
  // Inference switches (decision 2026-11-11; D71)
  'inference_settings_changed',
  // Change windows and freezes (spec 11.5, 11.6): a freeze set or ended, or an exception approved in one
  'change_freeze_set',
] as const;

/** High volume (spec 63.4): a refusal can come with every request. */
export const POLICY_HIGH_VOLUME_EVENTS = ['authorisation_denied'] as const;

export type PolicyEventName = (typeof POLICY_EVENTS)[number] | (typeof POLICY_HIGH_VOLUME_EVENTS)[number];
