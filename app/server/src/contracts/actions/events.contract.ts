// Write-back's events (spec 42.12, 43.14, 44.9, 45.8, 46.9).
//
// Audit: every stage of an Action is an audit_event (contracts/audit/auditEvent.contract.ts,
// whose catalogue lists these names), written to the outbox in the transaction that made
// the change. References and counts only: the object set and the field names, never the
// values, which live in the receipt (spec 43.14).
//
// Control: the stage a mutation reached, on bus-durable topic control.action ordered by the
// mutation id (spec 9.2: approval, execution, receipt, revert), for the state plane and the
// clients that follow an Action.

import { z } from 'zod';

export const ACTION_EVENTS = [
  // Outbound webhook side effects (spec 20.8), delivered by notify
  'outbound_webhook_delivered', 'outbound_webhook_failed',
  // Action types (42.12)
  'action_type_proposed', 'action_type_confirmed', 'action_type_rejected', 'action_type_version_published', 'action_type_blocked',
  // Chapter 21's name for the ontology element: an Action type defined by its first published version (D207).
  'action_type_defined',
  // 44.9: an approval policy created or superseded, before and after (D207).
  'policy_changed',
  // 48.1: a SQL table named by a confirmed Action type version, the only way it becomes a target (D207).
  'warehouse_target_confirmed',
  'action_type_retired', 'action_intent_bound', 'generic_edit_compiled',
  // The organisation allowing or disabling the generic governed edit (42.9): chapter 77 names no event for it.
  'generic_edit_policy_set',
  // The mutation path (43.14)
  'mutation_proposed', 'mutation_resolved', 'mutation_refused', 'blast_radius_computed', 'preview_generated', 'scenario_action_promoted',
  // Approval (44.9)
  'approval_requested', 'approval_granted', 'approval_rejected', 'approval_expired', 'self_approval_used', 'approval_policy_created',
  'approval_policy_superseded', 'policy_floor_set', 'policy_floor_overrode_configured_policy',
  // Execution and verification (45.8)
  'mutation_executed', 'canary_executed', 'canary_confirmed', 'canary_expired', 'canary_sample_set', 'mutation_verified', 'mutation_diverged', 'mutation_failed',
  'mutation_partially_failed', 'execution_stale_target', 'side_effect_fired', 'side_effect_failed',
  // Receipts, history and revert (46.9)
  'receipt_created', 'receipt_purged', 'commit_recorded', 'revert_requested', 'revert_conflicted', 'revert_conflict_decided',
  'revert_executed', 'revert_partial', 'record_recreated', 'id_remapped', 'link_repointed', 'link_not_repointed',
  // Earning writes (spec 17.1): the write-verify-undo class and the switch it gates
  'writes_enabled', 'writes_disabled',
  // Receipt purge is a wipe (65.3, 70.8): asked, approved or rejected, completed with its counts
  'purge_requested', 'purge_approved', 'purge_rejected', 'purge_completed',
  // Outbound Action events (48.4)
  'action_event_subscription_created', 'action_event_subscription_paused', 'action_event_delivered', 'action_event_dead_lettered',
  // Real-world actuation (47.8); requested and rejected added (D189), read with added
  'allowlist_entry_requested', 'allowlist_entry_rejected', 'allowlist_entry_added', 'allowlist_entry_removed', 'allowlist_signed',
  'physical_action_proposed', 'physical_action_approved', 'physical_action_dry_run', 'physical_action_executed', 'physical_action_verified',
  'physical_action_reverted', 'physical_write_refused_by_agent',
  'physical_write_rejected_by_control_system', 'physical_rate_limit_refused',
  // The organisation requiring a dry run before a physical Action (47.5): chapter 47.8 names no event for it.
  'physical_dry_run_policy_set',
] as const;
export type ActionEventName = (typeof ACTION_EVENTS)[number];

export const MUTATION_STAGES = [
  'previewed', 'awaiting_approval', 'approved', 'rejected', 'expired', 'canary', 'executing', 'completed', 'completed_with_divergence',
  'partially_failed', 'failed', 'refused', 'receipt_created', 'revert_requested',
] as const;

export const mutationStageMessage = {
  topic: 'control.action',
  name: 'mutation_stage',
  version: 1,
  schema: z.strictObject({
    mutationId: z.uuid(),
    stage: z.enum(MUTATION_STAGES),
    /** For a revert, the receipt it reverts; for receipt_created, the receipt. */
    receiptId: z.uuid().nullable(),
    rowCount: z.int().min(0),
  }),
} as const;
export type MutationStage = (typeof MUTATION_STAGES)[number];
