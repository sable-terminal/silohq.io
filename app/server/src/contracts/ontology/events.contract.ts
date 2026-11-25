// The ontology's audit events (spec 21.17, 22.9, 24.4, 25.10). They travel as the audit
// service's audit_event (contracts/audit/auditEvent.contract.ts), whose catalogue lists
// these names; services/ontology/events.service.ts maps onto it. References, counts and
// closed codes only: an element is named by id, never by a record value.

export const ONTOLOGY_EVENTS = [
  // Elements (21.17)
  'object_type_proposed', 'object_type_confirmed', 'object_type_rejected', 'property_mapped', 'property_unmapped', 'field_alias_set',
  'field_alias_removed', 'time_field_declared', 'link_type_proposed', 'link_type_confirmed', 'link_default_route_set', 'interface_created',
  'interface_implemented', 'shared_property_created', 'function_version_published', 'action_type_defined', 'visual_metadata_changed',
  'object_type_marking_changed',
  // Derivation (22.9)
  'derivation_started', 'derivation_completed', 'field_profiled', 'overlap_computed', 'proposal_created', 'proposal_decision_confirmed',
  'proposal_decision_corrected', 'proposal_rejected', 'template_reviewed', 'template_withdrawn',
  // Versioning and proposals (25.10)
  'ontology_branch_opened', 'ontology_branch_rebased', 'ontology_branch_abandoned', 'ontology_proposal_submitted', 'ontology_impact_computed',
  'ontology_proposal_approved', 'ontology_proposal_rejected', 'ontology_proposal_merged', 'ontology_merge_refused_impact_changed',
  'ontology_rolled_back', 'element_deprecated', 'element_retired', 'ontology_change_committed',
  // Object sets (24.4)
  'object_set_saved', 'object_set_shared', 'object_set_deleted',
] as const;
export type OntologyEventName = (typeof ONTOLOGY_EVENTS)[number];
