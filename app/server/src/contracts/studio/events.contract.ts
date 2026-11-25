// Studio's audit events (spec 35.13). They travel as the audit service's audit_event
// (contracts/audit/auditEvent.contract.ts), whose catalogue lists these names. References
// and counts only: an app by id, a version by number, never a definition or a value.
// app_version_published is read first: it names author, reviewer, scope and the version's
// markings.

export const STUDIO_EVENTS = [
  'app_created', 'app_draft_saved', 'app_submitted_for_review', 'app_version_returned', 'app_version_published', 'app_rolled_back',
  'app_published_to_scope', 'app_publication_withdrawn', 'app_shared', 'app_share_revoked', 'app_share_expired', 'app_transferred',
  'app_transfer_reviewed', 'app_opened_with_reduced_permissions', 'app_invalidated_by_ontology_change', 'app_generated_by_fde',
  'app_archived',
  // App branches (D229): opened, merged into main's next draft, abandoned.
  'app_branch_opened', 'app_branch_merged', 'app_branch_abandoned',
  // Staged releases (D230): begun with its first stage, each later stage, completed, rolled back.
  'app_release_started', 'app_release_stage_released', 'app_release_completed', 'app_release_rolled_back',
  // App packages (D231): exported into Files; imported as a new app or main's next draft.
  'app_package_exported', 'app_package_imported',
  // Object view layouts (34.7): a custom layout published for a type, or invalidated by an ontology change.
  'object_view_layout_published', 'object_view_layout_invalidated',
] as const;

/**
 * Per open (the high-volume class, 63.4). Not named in 35.13: the AI FDE's time to first app
 * counts an accepted app opened by a person other than the one who accepted it (54.1).
 */
export const STUDIO_HIGH_VOLUME_EVENTS = ['app_opened'] as const;
export type StudioEventName = (typeof STUDIO_EVENTS)[number] | (typeof STUDIO_HIGH_VOLUME_EVENTS)[number];
