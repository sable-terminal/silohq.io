// The audit events of Siloes (spec 66.12, 67.9, 68.11, 70.8): enabling and creating a Silo,
// its concepts and fields, retention, purge, Capture's queue and Import's files. The Object
// Index's (69.10) and the Warehouse's (69.22) are listed with their contracts.

export const SILO_EVENTS = [
  // 66
  'silo_enabled', 'silo_disabled', 'silo_created', 'silo_concept_added', 'silo_concept_removed', 'silo_fields_changed',
  // 67, 70
  'retention_changed', 'retention_swept', 'transition_captured_batch', 'purge_requested', 'purge_approved', 'purge_rejected',
  'purge_completed', 'purge_failed', 'capture_queue_drained',
  // 68
  'silo_source_created', 'silo_definition_published', 'file_received', 'file_processed', 'file_failed', 'extraction_flagged',
  'extraction_confirmed', 'silo_import_purged', 'extraction_carveout_acknowledged',
] as const;
export type SiloEventName = (typeof SILO_EVENTS)[number];
