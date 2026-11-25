// The search service's audit events (spec 34.6), as audit_event messages through the
// outbox. Counts and closed codes only: never the search text, never a matched value.

/** High volume (spec 63.4): an Explorer search. Cmd-K searches as a person types, and is not audited per keystroke. */
export const SEARCH_HIGH_VOLUME_EVENTS = ['explorer_search_run'] as const;

export type SearchEventName = (typeof SEARCH_HIGH_VOLUME_EVENTS)[number];
