// The Files audit events (spec 41.8). They travel as the audit service's audit_event
// (contracts/audit/auditEvent.contract.ts), whose catalogue lists these names. References
// and counts only: a file is named by id, never by its name or its contents.
//
// folder_created, folder_moved and file_renamed are not in spec 41.8: rearranging what a
// person sees is a change a reviewer must be able to read.

export const FILE_EVENTS = [
  'file_exported', 'file_uploaded', 'file_ingested', 'file_shared', 'file_share_revoked', 'file_opened', 'file_download_refused',
  'file_moved', 'file_deleted', 'file_retention_swept', 'file_renamed', 'folder_created', 'folder_moved',
  // The organisation's logo replaced (56.2, 56.10), by a super admin.
  'logo_replaced',
  // Media sets (D237, beyond the spec).
  'media_set_created', 'media_set_saved', 'media_set_archived', 'media_set_shared', 'media_set_share_revoked', 'media_item_added', 'media_item_removed',
  // Media linked to objects (D238).
  'media_link_rule_set', 'media_links_applied', 'media_item_linked', 'media_item_unlinked',
] as const;
export type FileEventName = (typeof FILE_EVENTS)[number];
