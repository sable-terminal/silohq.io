// Discovery's audit events (spec 19.7), as audit_event messages on the outbox. host_probed is
// listed with the high-volume query events in the audit catalogue: one per probe, and the
// event a security review reads first.

export const DISCOVERY_EVENTS = [
  'discovery_enabled', 'discovery_disabled', 'scan_authorised', 'scan_authorisation_revoked', 'scan_started', 'scan_completed',
  'finding_reviewed', 'finding_promoted_to_connector', 'finding_proposed_to_ontology',
] as const;
export type DiscoveryEvent = (typeof DISCOVERY_EVENTS)[number] | 'host_probed';
