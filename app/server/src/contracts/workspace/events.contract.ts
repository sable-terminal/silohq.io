// The workspace's audit events (spec 33.11, 37.12). They travel as the audit service's
// audit_event (contracts/audit/auditEvent.contract.ts), whose catalogue lists these names.
// References and counts only: a view is named by id, never by its name or a result.
//
// view_archived is not in spec 77; archiving is a change a reviewer must be able to see.

export const WORKSPACE_EVENTS = [
  // Saved views and sharing (37.12)
  'view_saved', 'view_renamed', 'view_archived', 'view_favourited', 'view_unfavourited', 'view_shared', 'view_share_revoked',
  'view_share_expired', 'view_share_suspended', 'view_transferred', 'view_transfer_reviewed', 'view_opened_with_reduced_permissions',
  'sharing_policy_changed', 'scope_sharing_narrowed', 'view_exported', 'analysis_step_refused', 'dashboard_tile_fallback',
  // Workbooks (D232, beyond the spec)
  'workbook_created', 'workbook_saved', 'workbook_archived', 'workbook_shared', 'workbook_share_revoked', 'workbook_exported',
  // Reports (D233, beyond the spec)
  'report_created', 'report_saved', 'report_archived', 'report_shared', 'report_share_revoked', 'report_exported',
  // Process analyses (D234, beyond the spec)
  'process_analysis_created', 'process_analysis_saved', 'process_analysis_archived', 'process_shared', 'process_share_revoked',
  'process_analysis_exported',
  // Data pipelines (D235, beyond the spec)
  'pipeline_created', 'pipeline_saved', 'pipeline_archived', 'pipeline_run_started', 'pipeline_run_completed', 'pipeline_run_failed',
  // Pipeline schedules (D241)
  'pipeline_schedule_set', 'pipeline_schedule_removed', 'pipeline_schedule_paused', 'pipeline_schedule_resumed', 'pipeline_run_skipped',
  // AI agents (D236, beyond the spec)
  'ai_agent_created', 'ai_agent_saved', 'ai_agent_archived', 'ai_agent_shared', 'ai_agent_share_revoked',
  // Notebooks (D239, beyond the spec)
  'notebook_created', 'notebook_saved', 'notebook_archived', 'notebook_shared', 'notebook_share_revoked', 'notebook_exported', 'notebook_question_compiled',
  // Machine learning models (D240, beyond the spec)
  'ml_model_created', 'ml_model_saved', 'ml_model_archived', 'ml_model_shared', 'ml_model_share_revoked', 'ml_model_trained', 'ml_model_training_failed',
  'ml_model_published', 'ml_model_predicted',
  // Shell (33.11)
  'terminology_skin_set', 'terminology_skin_superseded', 'ask_scope_widened', 'palette_command_run',
] as const;
export type WorkspaceEventName = (typeof WORKSPACE_EVENTS)[number];

/** Query events: frequent re-runs and dashboard tiles (spec 63.4, the high-volume class). */
export const WORKSPACE_HIGH_VOLUME_EVENTS = ['view_run'] as const;
