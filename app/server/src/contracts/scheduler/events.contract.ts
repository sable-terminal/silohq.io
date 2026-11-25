// The scheduler's audit events (spec 40.11). They travel as the audit service's
// audit_event (contracts/audit/auditEvent.contract.ts), whose catalogue lists these names.
// References and counts only: a Cron is named by id, never by its name, its condition's
// figure or a row of its result.
//
// automation_run_completed, automation_run_condition_indeterminate and
// automation_escalation_acknowledged are not in spec 40.11: a run with no condition, an
// undecided figure and an escalation's acknowledgement are each something a reviewer reads.

export const AUTOMATION_EVENTS = [
  'automation_created', 'automation_paused', 'automation_resumed', 'automation_deleted', 'automation_authorised',
  'automation_authorisation_expired', 'automation_run_started', 'automation_condition_met', 'automation_condition_not_met',
  'automation_run_skipped', 'automation_run_failed', 'automation_action_taken', 'automation_proposed_mutation',
  'automation_executed_mutation', 'automation_paused_on_halt', 'automation_paused_on_owner_removal', 'automation_change_gap',
  'automation_actuation_refused', 'automation_run_completed', 'automation_run_condition_indeterminate',
  'automation_escalation_acknowledged',
  // A Cron shared or a share revoked (spec 40.8: visibility and run history, never authorisation).
  'automation_shared',
  // Execute mode asked for with a physical Action type, refused at creation (spec 47.2, 47.8).
  'physical_cron_execute_refused',
] as const;
export type AutomationEventName = (typeof AUTOMATION_EVENTS)[number];
