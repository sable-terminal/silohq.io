// The lineage service's audit events (spec 59.7, 58.11, 34), as audit_event messages
// through the outbox. References and counts only.
//
// lineage_write_failed is written outside the failed artefact's transaction, which aborts;
// a reviewer reads it first, because an occurrence without a matching abort would mean an
// artefact exists without lineage.

/** Standard retention. */
export const LINEAGE_EVENTS = ['lineage_queried', 'lineage_exported', 'lineage_write_failed', 'marking_propagated'] as const;

/** High volume (spec 63.4): a reader opening the lineage of a figure. */
export const LINEAGE_HIGH_VOLUME_EVENTS = ['lineage_opened'] as const;

export type LineageEventName = (typeof LINEAGE_EVENTS)[number] | (typeof LINEAGE_HIGH_VOLUME_EVENTS)[number];
