// The query path's audit events (spec 26.14, 27.12; catalogue chapter 77), raised by
// compile, the planner and the executor as the audit service's audit_event. Query events
// are the high-volume class (spec 63.4). References, counts, bound names and closed-set
// reasons only: never a question, a value or a parameter.

export const QUERY_EVENTS = [
  // Compile (spec 26.14). tokens_charged is metering's own record.
  'compile_requested', 'compile_refused', 'compile_clarification_returned', 'plan_validated', 'plan_bounds_refused',
  // The engine (spec 27.12). query_executed is listed with the platform events.
  'query_refused_bounds', 'query_refused_source_unavailable', 'pushdown_local_filter_applied', 'aggregate_partial_pushdown_used',
  // 27.12 (D207): a fresh answer's lineage, its columns and the systems, objects and engines they came from.
  'lineage_recorded',
  // 62.4, 62.8 (D207): a stored plan's prompt vocabulary carries markings, which its views and answers inherit.
  'prompt_vocabulary_marked',
  // The object view (spec 34): the object, the reader and how many properties were withheld, never a value.
  'object_view_opened',
  // Spec 57.11: a type the reader's markings left out of a question's vocabulary, by reference and the count of
  // markings lacking, never the question. One per type per compile: the evidence the compiler rule is enforced.
  'type_dropped_from_plan',
] as const;
export type QueryEventName = (typeof QUERY_EVENTS)[number] | 'query_executed';

/** Compile's standard-class events (spec 26.14): calendar_changed is read first, since it changes every saved period's meaning. */
export const COMPILE_EVENTS = ['calendar_changed'] as const;
export type CompileEventName = (typeof COMPILE_EVENTS)[number];
