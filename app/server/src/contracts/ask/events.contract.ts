// Ask's audit events (spec 36.13). They travel as the audit service's audit_event, whose
// catalogue lists these names. ask_question_compiled carries the manifest reference and the
// tokens charged, never the question or a result value.

export const ASK_EVENTS = [
  'ask_question_compiled', 'ask_refused', 'ask_clarification_offered', 'ask_clarification_chosen', 'ask_rephrase_uncharged',
  'ask_action_proposed', 'ask_cron_proposed', 'ask_scenario_started', 'ask_web_context_added', 'ask_web_policy_changed',
  'ask_thread_archived',
] as const;
export type AskEventName = (typeof ASK_EVENTS)[number];
