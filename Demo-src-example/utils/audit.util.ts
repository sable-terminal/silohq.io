/**
 * The one way an audit row is written.
 *
 * A SINGLE INTERFACE SO NO SERVICE WRITES AUDIT ROWS DIRECTLY. Not tidiness: an
 * audit trail is only evidence if it is complete and uniform, and a service that
 * inserts its own row will get a field wrong, or forget one, or write a shape
 * that the query nobody has written yet cannot read. There is one writer.
 *
 * APPEND ONLY, ENFORCED BY GRANT. The application role holds INSERT and SELECT on
 * this table and never UPDATE or DELETE. A trail the application can rewrite is
 * not a trail — and the constraint belongs in the database, because the reviewer
 * asking will check the grants rather than the code.
 *
 * THE EVENT NAMES ARE A CLOSED SET. Free text produces four spellings of the same
 * event and a report that silently omits three of them.
 */

export type AuthEvent =
  // Identity
  | 'login' | 'login_failed' | 'lockout' | 'password_changed'
  | 'password_reset_requested' | 'password_reset_consumed'
  | 'mfa_enrolled' | 'mfa_satisfied' | 'session_revoked'
  // Membership
  | 'member_invited' | 'member_joined' | 'member_suspended'
  | 'member_removed' | 'member_reinstated'
  // Scopes
  | 'scope_type_created' | 'scope_created' | 'scope_moved' | 'scope_archived'
  | 'scope_membership_added' | 'scope_membership_removed'
  // Delegation and grants
  | 'admin_delegated' | 'admin_revoked' | 'grant_orphaned'
  | 'role_granted' | 'role_revoked'
  | 'clearance_granted' | 'clearance_revoked'
  | 'connection_granted' | 'connection_revoked'
  | 'grant_revoked_by_other_admin' | 'grants_silenced' | 'grants_restored'
  | 'membership_suspended_with_active_grants'
  // Policy
  | 'field_policy_changed' | 'concept_marking_changed'
  /* §2.8 — which system decides a field. It changes what every later answer
     says a number IS, so moving one has to be findable afterwards. */
  | 'field_authority_declared' | 'field_authority_retired'
  /* §2.3 — what this organisation calls a column, where the naming
     convention got it wrong. Inherited by every later concept. */
  | 'field_alias_declared' | 'field_alias_removed'
  /* §2.3 (131) — the same, learned from an answer: which system's field is read
     under which name, and how many records bore it out. Never the values. */
  | 'field_alias_learned'
  /* And taken back by Silo, when a later answer found the two no longer agree. */
  | 'field_alias_unlearned'
  /* §7 — a question in plain English, compiled into a plan. The OUTCOME
     and the cost are recorded; the question itself never is. */
  | 'question_compiled'
  /* Mutations §3 — a change in plain English, compiled. The outcome and the cost, never the words. */
  | 'mutation_compiled'
  /* §7.3 — which field of a concept a period applies to. It decides what
     every dated question afterwards is measured against. */
  | 'concept_time_field_declared'
  | 'approval_policy_created' | 'approval_policy_superseded'
  | 'policy_authority_delegated' | 'policy_authority_revoked'
  | 'policy_floor_set' | 'policy_floor_overrode_configured_policy'
  /* Mutations §14 — a connection's approval policy, and a super admin taking
     or giving back the say over it. */
  | 'policy_changed' | 'policy_authority_locked' | 'policy_authority_unlocked'
  /*
   * Mutations §15 — every stage before anything is written. None carries a
   * value: fields by name, records by count, and the diff by its digest.
   */
  | 'mutation_proposed' | 'mutation_resolved' | 'blast_radius_computed'
  | 'preview_generated'
  /* A mutation nobody carried through, gone with everything it read. */
  | 'mutation_discarded'
  /* §8, §10–§11 — the write itself, what came back, and the sample before a bulk one. */
  | 'mutation_executed' | 'mutation_verified' | 'mutation_diverged' | 'mutation_failed'
  | 'canary_executed' | 'canary_confirmed' | 'canary_halted'
  /* §13 — undoing a change is a change, and these name the one it undoes. */
  | 'revert_requested' | 'revert_conflicted' | 'revert_executed'
  /* A change's receipt: how long receipts are kept, and one deleted sooner. */
  | 'receipt_retention_changed' | 'mutation_purge_requested' | 'mutation_purged'
  // Approvals
  | 'approval_requested' | 'approval_granted' | 'approval_rejected'
  | 'approval_expired' | 'self_approval_used'
  // Seats and billing
  /* Billing §12 — the subscription itself, and what it entitles. */
  | 'subscription_created' | 'plan_changed'
  | 'seat_allocated' | 'seat_assigned' | 'seat_reclaimed' | 'seat_unassigned'
  | 'seat_released' | 'seat_pool_allocated' | 'seat_pool_released'
  | 'tokens_purchased' | 'auto_topup_toggled'
  /* Billing §4 — what was granted, and the two ways a limit bites. */
  | 'allowance_granted' | 'allowance_exhausted' | 'daily_limit_reached'
  /* BILLING §2 — the organisation's own ceiling on a person's day, which may only tighten the plan's. */
  | 'daily_limit_set'
  /* Billing §6 — a Silo's bytes and what the provider charged for them. */
  | 'storage_measured'
  // Views
  | 'view_shared' | 'view_share_revoked' | 'view_share_expired'
  | 'view_transferred' | 'view_transfer_reviewed'
  | 'view_opened_with_reduced_permissions'
  | 'sharing_policy_changed' | 'scope_sharing_narrowed'
  // §7.3 — the calendar every period is measured against
  | 'calendar_changed'
  /* §12 — what this organisation calls a concept. Presentation, not identity. */
  | 'terminology_set' | 'terminology_cleared'
  /*
   * Automations §13 — a scheduled check: its life, and every run of it.
   *
   * EVERY RUN, INCLUDING THE ONES THAT DID NOTHING. §11 — "An automation that
   * has not fired in three months is either working or broken, and the run
   * history is the only way to tell." So `condition_not_met` is as much a row
   * as `condition_met`, and a skip is recorded rather than leaving a gap.
   */
  | 'automation_created' | 'automation_paused' | 'automation_resumed' | 'automation_deleted'
  | 'automation_run_started' | 'automation_condition_met' | 'automation_condition_not_met'
  | 'automation_run_skipped' | 'automation_run_failed' | 'automation_action_taken'
  /*
   * §13 — a change an automation put in the queue. Not a write: a person
   * approves it, and the approval and the execution keep their own rows.
   */
  | 'automation_proposed_mutation'
  /*
   * §8 and §9 — paused by something other than a person. Both exist because a
   * check that quietly stops checking is worse than one that fails loudly.
   */
  | 'automation_paused_on_halt' | 'automation_paused_on_owner_removal'
  /* §4 — a notification that requires an answer, and the answer. */
  | 'automation_escalated' | 'automation_escalation_acknowledged'
  /*
   * §5 and §13 — permission to write with nobody present, and the writes it
   * allowed. `automation_executed_mutation` is, per §13, "the row an auditor
   * reads first, because it is the only write in the product with nobody
   * present at the moment it happened".
   */
  | 'automation_authorised' | 'automation_authorisation_revoked'
  | 'automation_authorisation_expired' | 'automation_executed_mutation'
  /*
   * Files §9. `file_download_refused` is the one a reviewer asks for: §4 makes
   * Silo access a precondition for opening a file drawn from one, and this row
   * is the evidence that boundary is working rather than merely claimed.
   */
  | 'file_exported' | 'file_uploaded' | 'file_ingested'
  | 'file_shared' | 'file_share_revoked'
  | 'file_opened' | 'file_download_refused'
  | 'file_moved' | 'file_deleted' | 'file_retention_swept'
  /*
   * Simulation §9. `simulation_crossed_unconfirmed_edge` is the one §9 calls
   * out: "the rate of it is the only measure of whether the graph is complete
   * enough to trust". The rest arrive with the steps that write them.
   */
  | 'graph_edge_proposed' | 'graph_edge_confirmed' | 'graph_edge_revised' | 'graph_edge_retired'
  | 'graph_edge_observed'
  | 'scenario_saved' | 'simulation_run' | 'simulation_bounded'
  | 'simulation_crossed_unconfirmed_edge' | 'scenario_shared' | 'scenario_compared'
  // Objects and identity providers
  | 'logo_replaced' | 'provider_configured'
  | 'scim_token_issued' | 'scim_token_revoked'
  /* §1 — what a directory group was authorised to carry, and by whom. */
  | 'scim_group_mapped' | 'scim_group_unmapped'
  | 'scim_user_provisioned' | 'scim_user_deactivated' | 'scim_user_reactivated'
  | 'cron_paused_on_removal' | 'object_ownership_transferred'
  // Machine identities
  | 'principal_created' | 'principal_disabled' | 'principal_enabled'
  | 'api_key_issued' | 'api_key_revoked' | 'principal_role_granted'
  // Connectors
  | 'connector_created' | 'connector_manifest_versioned'
  | 'probe_started' | 'probe_completed' | 'probe_failed'
  | 'mapping_confirmed' | 'trust_tier_promoted' | 'writes_enabled'
  | 'credential_sealed' | 'credential_unwrapped' | 'connection_parameters_set'
  | 'oauth_flow_started' | 'oauth_flow_completed' | 'oauth_scope_missing'
  | 'token_refreshed' | 'token_refresh_failed'
  | 'heal_proposed' | 'heal_applied' | 'heal_halted'
  | 'heal_reviewed'
  | 'connection_halted' | 'connection_resumed'
  /* Route 2's build: the AI tested its draft against the real system, and the person connected it. */
  | 'connector_build_tested' | 'connector_build_connected'
  /* Every field a system holds: its field list read, and the connector widened to read it all. */
  | 'connector_fields_listed'
  /*
   * THE CONNECTION ITSELF, NOT A GRANT ON IT. `connection_revoked` above sits
   * beside `connection_granted` and carries a grantee, so it is about somebody
   * losing access. Retiring the connection is a different act with a different
   * blast radius — every grant on it stops mattering at once — and reusing one
   * name for both would make the trail unreadable exactly where it matters.
   */
  | 'connection_retired'
  // Agent discovery
  | 'discovery_enabled' | 'discovery_disabled'
  | 'scan_authorised' | 'scan_authorisation_revoked'
  | 'scan_started' | 'scan_completed' | 'host_probed'
  | 'finding_reviewed' | 'finding_promoted_to_connector'
  /*
   * Ontology — §9 of the recognition spec.
   *
   * `concept_marking_changed` IS ALREADY ABOVE, under Policy, and is the same
   * event the spec calls `concept_marking_set`. One name, kept where the auth
   * layer put it: two spellings of one act is exactly what a closed set exists
   * to prevent.
   */
  | 'concept_proposed' | 'concept_confirmed' | 'concept_corrected'
  /* §2.4 (132) — a concept across systems Silo made itself, because their
     records bore the proposal out. Which fields and how many records; never a value. */
  | 'concept_learned'
  /* Siloes (135) — a concept somebody chose to keep a copy of, and one they stopped keeping. */
  | 'silo_concept_kept' | 'silo_concept_released'
  /* Siloes (139) — an identity outside Silo given leave to read a Silo's views, and one that lost it. */
  | 'silo_reader_granted' | 'silo_reader_revoked'
  | 'unresolved_pair_proposed' | 'unresolved_pair_confirmed' | 'unresolved_pair_rejected'
  /*
   * Detection — §9. `finding_reviewed` and `finding_promoted_to_connector`
   * above are DISCOVERY's, about a host somebody found on a network. These are
   * a detector's, about two systems disagreeing. Same word, two subjects, which
   * is a collision worth resolving by renaming discovery's rather than by
   * spelling these differently.
   */
  | 'detector_run' | 'finding_raised' | 'finding_dismissed' | 'finding_confirmed'
  /*
   * §4. `associations_computed` replaces the whole set for the concepts it
   * touched, so the log is the only record that an earlier set existed and what
   * it was computed from. An outcome designation orders every ranking anybody
   * sees afterwards, which makes who declared it the interesting column.
   */
  | 'associations_computed' | 'outcome_designated' | 'outcome_retired'
  /*
   * §5. The one event where a model changed what somebody saw. It records the
   * model version and the token cost because "why was this first in March" is a
   * question the row has to answer after the model has moved on.
   */
  | 'findings_ranked'
  /*
   * §6. A map is shareable and full of references, so who shared what with whom
   * is the question an audit asks first — `map_shared` carries the coverage
   * because "they can see 12% of it" is the part that decides whether the share
   * was meaningful or was somebody handing over their grants.
   */
  | 'map_created' | 'map_archived' | 'map_shared' | 'map_share_revoked'
  /*
   * §10 — Siloes. The one part of the product that holds a customer's values,
   * so every step that turns it on, widens it, or destroys what it holds leaves
   * a row.
   *
   * `retention_changed` RECORDS BOTH WINDOWS, because shortening one destroys
   * data at the next sweep and that is the change a reviewer asks about.
   *
   * `purge_completed` IS THE RECEIPT'S COUNTERPART. The receipt survives the
   * data; this survives the receipt.
   */
  | 'silo_enabled' | 'silo_disabled' | 'silo_created'
  | 'silo_concept_added' | 'silo_concept_removed' | 'silo_fields_changed'
  | 'retention_changed' | 'retention_swept'
  | 'transition_captured_batch'
  | 'purge_requested' | 'purge_approved' | 'purge_completed'
  | 'capture_queue_drained'
  /* §4 — the approval chain: configured, and a purge refused by the second person. */
  | 'approval_policy_set' | 'approval_policy_removed' | 'purge_rejected'
  /*
   * Import §13. `extraction_carveout_acknowledged` records who accepted that
   * document contents go to a model, and when — the row a security reviewer
   * asks for.
   */
  | 'silo_source_created' | 'silo_definition_published'
  | 'file_received' | 'file_processed' | 'file_failed'
  | 'extraction_flagged' | 'extraction_confirmed'
  | 'silo_import_purged' | 'extraction_carveout_acknowledged'
  /* A watched location stopped: its credential destroyed, its files kept. */
  | 'silo_source_retired'
  /* A watched location's credential opened for a pickup. Read beside `credential_unwrapped`. */
  | 'watch_credential_unwrapped'
  /* The carve-out withdrawn: no further document goes to a model. */
  | 'extraction_carveout_withdrawn'
  /* 129 — answers written up by a model: switched off by a super admin, and back on. */
  | 'answer_reading_switched_off' | 'answer_reading_switched_on'
  /* 130 — context from the web, switched off for the whole organisation, and back on. */
  | 'web_context_switched_off' | 'web_context_switched_on'
  /*
   * §9 — the six the spec names that nothing emitted.
   *
   * `threshold_tuned` IS THE ONE THAT MATTERS MOST. A threshold decides whether
   * a finding exists at all, so "why did this stop appearing in March" is a
   * question only a row can answer — and §3.4's whole promise is that the
   * system tunes itself, which is unreviewable if the tuning leaves no trace.
   *
   * `ranking_overridden` and `archetype_overridden` record a PERSON disagreeing
   * with the model or the precedence, which is the feedback §5.5 and §7.3 are
   * built on and the evidence that somebody looked.
   *
   * `map_used_with_reduced_permissions` is §6.4: a shared map resolving against
   * the opener's grants, with elements dropped. Silence there would make a
   * half-inert map indistinguishable from a whole one.
   */
  | 'threshold_tuned'
  | 'ranking_overridden'
  | 'archetype_selected' | 'archetype_overridden' | 'representation_switched'
  | 'element_drilled' | 'flag_opened' | 'view_exported'
  | 'map_forked'
  | 'map_switched'
  | 'map_used_with_reduced_permissions'
  /*
   * MANIFEST-V2 §3.4 — the agent: a process in the organisation's own network
   * that reaches what Silo cannot. Which hosts it may contact for a connection
   * is the admin's confirmation, and the row that says who confirmed what.
   */
  | 'agent_created' | 'agent_enrolled' | 'agent_revoked' | 'agent_hosts_confirmed'
  /*
   * §9.2 — where a connection's credential may go and which statements it may
   * run, as confirmed by whoever connected it or moved it to a new version.
   */
  | 'connection_pins_confirmed' | 'connection_version_adopted'
  /* A credential about to lapse, and which warning was sent: two weeks, three days, or on the day. */
  | 'credential_expiry_warned'
  /* §3.7 — whether this organisation's prebuilt connectors move to new versions by themselves. */
  | 'connector_updates_changed';

export interface AuditEntry {
  event: AuthEvent;
  organisationId: string;
  /** The membership acting. Null only where there genuinely is none: a failed login. */
  membershipId: string | null;
  userId: string | null;
  detail: Record<string, unknown>;
  ipHash?: string | null;
  occurredAt: Date;
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/**
 * Detail that certain events must carry.
 *
 * THESE ARE THE CHAINS A REVIEWER WALKS BACKWARDS. `admin_delegated` without the
 * granter's scope at the time cannot be evaluated after a restructure — the tree
 * has changed and there is no way to establish whether the grant was valid when
 * it was made. `scope_moved` without both paths hides the fact that moving one
 * node silently changed who administers everything beneath it.
 *
 * Enforced here rather than trusted, because the row is written once and read
 * years later, when the omission cannot be repaired.
 */
export const REQUIRED_DETAIL: Partial<Record<AuthEvent, readonly string[]>> = {
  /*
   * THE TWO EVENTS AN ATTACK IS VISIBLE IN, and the two that must not become a
   * place where the attack's own material is stored. The detail carries the
   * method and the position in the sequence and NOTHING ELSE: never the
   * submitted password, never the address that was tried. A row is written only
   * for an account that exists, so the table cannot be read as a list of which
   * addresses are registered either.
   *
   * `attempt` IS THE PART THAT CANNOT BE RECONSTRUCTED. The counter on `users`
   * is cleared by the next successful sign-in, so a row saying only "a login
   * failed" leaves no way to tell one typo from the seventh guess in a run.
   */
  login_failed: ['method', 'attempt'],
  /*
   * `lockoutSeconds` BECAUSE THE CONFIGURED DURATION IS WHAT WAS APPLIED, and it
   * is a constant somebody will change. Without it, a row from last year cannot
   * say how long that account was actually shut out.
   */
  lockout: ['method', 'attempts', 'lockoutSeconds'],

  admin_delegated: ['granterMembershipId', 'granterScopePath', 'targetScopePath', 'permissions'],
  admin_revoked: ['targetMembershipId', 'scopePath'],
  scope_moved: ['scopeId', 'oldPath', 'newPath'],
  role_granted: ['targetMembershipId', 'roleId', 'grantedAtScopePath'],
  clearance_granted: ['targetMembershipId', 'markingId'],
  connection_granted: ['connectionId', 'granteeType', 'granteeId', 'grantedAtScopePath'],
  connection_revoked: ['connectionId', 'granteeType', 'granteeId'],

  /*
   * A RESUME HAS TO SAY WHAT WAS LOOKED AT. §8 halts because continuing would
   * answer wrongly; the person clearing it is asserting that they checked, and a
   * row that does not record what they were shown makes that assertion
   * unauditable.
   */
  connection_resumed: ['connectionId', 'previousReason'],
  connection_retired: ['connectionId', 'reason'],
  heal_reviewed: ['connectionId', 'proposalId', 'decision'],
  grant_revoked_by_other_admin: ['grantId', 'originalGranterMembershipId', 'revokerMembershipId'],
  self_approval_used: ['mutationId', 'approverMembershipId'],
  /*
   * Mutations §15. WHICH FIELDS AND WHICH SYSTEMS, from the first row — a
   * proposal that later fails still says what it would have touched. The
   * preview's DIGEST is required because it is the only thing in the trail that
   * ties an approval to the exact diff approved, without the values.
   */
  mutation_proposed: ['mutationId', 'conceptId', 'operation', 'fields', 'connections'],
  mutation_resolved: ['mutationId', 'outcome'],
  blast_radius_computed: ['mutationId', 'consequences', 'uncounted'],
  preview_generated: ['mutationId', 'records', 'bulk', 'digest'],
  mutation_discarded: ['mutationId', 'reason'],
  /*
   * §15 — "mutation_executed carries the entity set and the fields, not the
   * values." The identifiers of the records that took the write, per system,
   * and the concept fields written. What they held is in the receipt.
   */
  mutation_executed: ['mutationId', 'connectionId', 'refs', 'fields'],
  mutation_verified: ['mutationId', 'connectionId', 'records'],
  mutation_diverged: ['mutationId', 'connectionId', 'refs', 'fields'],
  mutation_failed: ['mutationId', 'connectionId', 'records', 'refs'],
  canary_executed: ['mutationId', 'records', 'applied', 'failed'],
  canary_confirmed: ['mutationId'],
  canary_halted: ['mutationId', 'reason'],
  revert_requested: ['mutationId', 'revertsMutationId', 'records'],
  revert_conflicted: ['mutationId', 'revertsMutationId', 'refs', 'fields'],
  revert_executed: ['mutationId', 'revertsMutationId', 'outcome'],
  /* Which field of which system became hidden or visible, and to whom. */
  field_policy_changed: ['change', 'connectionId', 'fieldPath'],
  mutation_compiled: ['outcome', 'inputTokens', 'outputTokens'],
  /* Both windows: shortening one deletes every receipt the difference covers. */
  receipt_retention_changed: ['retentionDays', 'previousRetentionDays'],
  mutation_purge_requested: ['mutationId', 'approvalRequestId'],
  mutation_purged: ['mutationId', 'records'],
  /*
   * Billing §12 — WHAT CHANGED AND WHAT IT COSTS. A plan change without the
   * seats and the price is a row that cannot be reconciled with an invoice.
   */
  subscription_created: ['plan', 'seats', 'term'],
  /*
   * A RELEASE BY COUNT NAMES NO SEAT, and says when the lower count starts
   * being billed — which is the whole difference between it and offboarding.
   */
  seat_pool_released: ['removed', 'seats', 'effectiveAt'],
  /*
   * §4 — WHAT WAS GRANTED AND WHAT WAS REFUSED. "How often do people run out"
   * is a question about the pricing, and it is answered from these rows.
   */
  allowance_granted: ['kind', 'granted'],
  allowance_exhausted: ['weight'],
  daily_limit_reached: ['weight'],
  tokens_purchased: ['quantity', 'amountPence', 'auto'],
  /*
   * §6 — "10% over cost is a claim that only means something if the cost is
   * visible." A measurement without the bytes and the provider's own cost is a
   * charge nobody can check, which is the opposite of what §6 is for.
   */
  storage_measured: ['siloId', 'bytesHeld', 'bytesScanned', 'providerCostPence'],
  auto_topup_toggled: ['enabled'],
  plan_changed: ['plan', 'previousPlan', 'seats', 'term'],
  /*
   * Mutations §9. THE TERMS A CHAIN IS HELD TO, on the row that opened it, so
   * "who had to agree to this" is answered from the trail without the chain —
   * which is discarded with the mutation when it lapses.
   */
  approval_requested: ['mutationId', 'approvalsRequired', 'expiresAt'],
  approval_granted: ['mutationId', 'approverMembershipId'],
  approval_rejected: ['mutationId', 'approverMembershipId'],
  approval_expired: ['mutationId'],
  /*
   * §12 — WHICH CONCEPT, AND WHAT IT IS CALLED NOW. A skin changes what every
   * reader in the organisation is told a thing is, so "why does this say
   * Matter" has to be answerable from the row rather than from whoever
   * remembers changing it.
   */
  /*
   * Automations §13 — WHICH AUTOMATION, ALWAYS. Every one of these is read
   * while answering "what has this thing been doing", and a row that names the
   * event without naming the automation cannot answer it.
   */
  automation_created: ['automationId', 'viewId', 'schedule'],
  automation_paused: ['automationId', 'reason'],
  automation_resumed: ['automationId'],
  automation_deleted: ['automationId'],
  automation_run_started: ['automationId'],
  automation_condition_met: ['automationId'],
  automation_condition_not_met: ['automationId'],
  automation_run_skipped: ['automationId', 'reason'],
  automation_run_failed: ['automationId', 'reason'],
  automation_action_taken: ['automationId', 'kind', 'outcome'],
  /*
   * §13 — WHICH AUTOMATION AND WHICH MUTATION, so the queue can be read
   * backwards: an approver looking at a change nobody remembers asking for
   * follows this to the schedule that asked for it.
   */
  automation_proposed_mutation: ['automationId', 'mutationId', 'operation'],
  /*
   * WHAT PAUSED IT, AND WHAT CAUSED THAT. "Why did this stop running" is the
   * question these answer, and the connection or the membership is the half
   * that makes the answer actionable.
   */
  /*
   * §4 — WHO IT WAITS ON. An escalation is a notification with a state, and the
   * trail has to say whose state it is, or "which of these has nobody picked
   * up" is unanswerable from the record.
   */
  /*
   * §5 — WHO AUTHORISED IT, WITHIN WHAT, AND UNTIL WHEN. An authorisation
   * recorded without its bounds cannot be reviewed, and reviewing them before
   * the expiry is the only reason the expiry exists.
   */
  automation_authorised: ['automationId', 'authorisationId', 'records', 'expiresAt'],
  automation_authorisation_revoked: ['automationId'],
  automation_authorisation_expired: ['automationId'],
  /*
   * §13 — "names the authorising membership, the automation, and the bounds it
   * ran within". The authorising membership is on every run, not just at
   * creation, because "a change with no human name attached is the thing an
   * auditor rejects".
   */
  automation_executed_mutation: [
    'automationId', 'mutationId', 'authorisationId', 'records', 'connections',
  ],
  /*
   * Files §9 — WHICH FILE, ALWAYS, and for an export what it was made from.
   * "Where did this figure come from" is answerable from the trail only if the
   * row that made the document says what it was made from.
   */
  file_exported: ['fileId', 'sourceKind'],
  file_opened: ['fileId'],
  /* §2 — which file went where. The folder grants nothing, so naming it is
     arrangement rather than access. */
  file_moved: ['fileId'],
  /* §4 — who it reached and on what terms. A share row with no grantee type
     cannot answer "who can open this", which is the question it exists for. */
  file_shared: ['fileId', 'shareId', 'granteeType', 'access'],
  file_share_revoked: ['fileId', 'shareId'],
  /* §5 — which document became data, and where it went. */
  file_uploaded: ['fileId', 'siloId', 'outcome'],
  file_ingested: ['fileId', 'siloId', 'sourceId'],
  /*
   * §6 — "what was removed, by whom, and what stopped working as a result."
   * The detectors are the third of those, and the reason a deletion of Silo
   * data is a purge rather than a tidy-up.
   */
  file_deleted: ['fileId', 'scope'],
  /* Files §6 — an upload deleted because its Silo's window closed on it. The
     Silo, so a reviewer can tie the deletion to the window that caused it. */
  file_retention_swept: ['siloId', 'filesRemoved'],
  /* Rendering §11 — what a result was drawn as, and what also fitted. */
  archetype_selected: ['resultRef', 'archetype', 'alternatives'],
  /*
   * §11 — "archetype_overridden carries the RESULT STRUCTURE and both
   * archetypes. It is the feedback that tells you precedence is wrong, and
   * there is no other source for it." All four are required for that reason:
   * a row missing the structure cannot tell anybody WHICH shape is being
   * argued with, which is the whole question.
   */
  archetype_overridden: ['resultRef', 'archetype', 'overriddenTo', 'signals'],
  /* §2 — which of the three, for which view. The other half of §4.3's
     feedback: somebody who leaves the view and reads the rows instead is
     making the same complaint an override makes, where nothing sees it. */
  representation_switched: ['viewId', 'representation'],
  /*
   * §5 — "Select an element and see its lineage… Drill in to the records
   * behind it." The drill is the moment a reader stops looking at a figure and
   * starts looking at what it was made of, and it is the one interaction that
   * reaches records rather than presentation.
   */
  element_drilled: ['resultRef', 'fieldPath', 'records'],
  /*
   * §6 — which flag somebody opened.
   *
   * WORTH RECORDING BECAUSE THE ALTERNATIVE IS ASSUMING. A product that shows
   * disagreements and cannot say whether anybody ever opens one is a product
   * guessing about the feature it most wants to be right about.
   */
  flag_opened: ['resultRef', 'flagKind', 'subject'],
  /* §9 — rendered output left the product. */
  view_exported: ['viewId', 'fileId', 'archetype', 'records'],
  /*
   * §2.2 — WHICH EDGE AND WHERE IT CAME FROM. "A simulation resting on stated
   * lead times is a different claim from one resting on four hundred
   * observations", and the trail has to say which this was.
   */
  graph_edge_proposed: ['edgeId', 'fromConceptId', 'toConceptId', 'source'],
  /*
   * §2.3 — WHAT WAS DECIDED, NOT JUST THAT SOMETHING WAS. A confirmation whose
   * row says only "an edge was confirmed" leaves §5 unable to answer whether
   * two results are comparable, which is the question the trail exists to
   * settle here.
   */
  graph_edge_confirmed: [
    'edgeId', 'fromConceptId', 'toConceptId', 'source', 'edgeKind',
    'leadTimeValue', 'leadTimeUnit',
  ],
  graph_edge_revised: [
    'edgeId', 'fromConceptId', 'toConceptId', 'source', 'edgeKind',
    'leadTimeValue', 'leadTimeUnit', 'version',
  ],
  graph_edge_retired: ['edgeId', 'fromConceptId', 'toConceptId', 'source', 'version'],
  /*
   * §2.2 — "A simulation resting on stated lead times is a different claim from
   * one resting on four hundred observations." The sample count is required
   * here for exactly that reason: without it the row says a lead time was
   * measured and declines to say how well.
   */
  graph_edge_observed: [
    'edgeId', 'fromConceptId', 'toConceptId', 'source', 'sampleCount',
    'leadTimeValue', 'leadTimeUnit',
  ],
  scenario_saved: ['scenarioId', 'failedConceptId', 'mode', 'graphVersion'],
  /*
   * §5 — THE GRAPH VERSION IS ON THE RUN, not only in the result table. "An
   * edge confirmed differently since means the two results are not comparable",
   * and somebody reconstructing that from the trail alone needs the version
   * beside the run rather than having to go and find the run row.
   */
  simulation_run: ['runId', 'scenarioId', 'mode', 'graphVersion', 'affected'],
  simulation_bounded: ['runId', 'hop', 'bound'],
  /*
   * §9 — "the one that matters. It records every time a simulation stopped
   * short, and the rate of it is the only measure of whether the graph is
   * complete enough to trust." Which edge, so the rate can be turned into a
   * list of what to go and confirm.
   */
  simulation_crossed_unconfirmed_edge: ['runId', 'edgeId', 'atConceptId'],
  /* §7 — who was given the question. Not the answer: §7's marking rule is
     applied to whoever runs it, so what they see is bounded by their own
     clearance rather than by the owner's. */
  scenario_shared: ['scenarioId', 'sharedWith', 'mode'],
  /* §5 — two runs, and how far apart they came out. */
  scenario_compared: ['scenarioId', 'runId', 'entered', 'left', 'graphVersion'],
  file_download_refused: ['fileId', 'reason'],
  automation_escalated: ['automationId', 'escalationId'],
  automation_escalation_acknowledged: ['escalationId'],
  automation_paused_on_halt: ['automationId', 'connectionId', 'reason'],
  automation_paused_on_owner_removal: ['automationId', 'targetMembershipId', 'reason'],
  terminology_set: ['conceptId', 'name', 'term'],
  terminology_cleared: ['conceptId', 'name'],
  policy_changed: ['change', 'connectionId'],
  policy_floor_set: ['change', 'connectionId'],
  policy_authority_delegated: ['connectionId', 'targetMembershipId'],
  policy_authority_revoked: ['connectionId', 'targetMembershipId'],
  policy_authority_locked: ['connectionId'],
  policy_authority_unlocked: ['connectionId'],
  policy_floor_overrode_configured_policy: ['connectionId', 'configuredPolicy', 'appliedFloor'],
  seat_released: ['seatId', 'effectiveAt'],
  /*
   * A KEY IS A CREDENTIAL WITH NO OWNER PRESENT, so the record of issuing one
   * has to answer more than "somebody made a key". Which identity it belongs to
   * and when it dies are the two things an auditor needs and neither can be
   * reconstructed afterwards — the plaintext is gone and the expiry may have
   * been changed since.
   */
  api_key_issued: ['principalId', 'keyId', 'expiresAt'],
  api_key_revoked: ['principalId', 'keyId'],
  principal_role_granted: ['principalId', 'roleId', 'grantedAtScopePath'],

  /*
   * A CONNECTOR EVENT THAT DOES NOT NAME ITS MANIFEST VERSION IS UNUSABLE.
   * Manifests are immutable once used and every returned figure cites a version
   * in its lineage, so "the connector was changed" without saying which version
   * replaced which cannot be reconciled with the answers that came out of it.
   */
  /*
   * NO `connectionId`, BECAUSE THERE IS NOT ONE YET. A manifest is versioned
   * when it is published and connections are made from it afterwards — often
   * several, often later. Requiring a connection here would mean either not
   * recording the publish or inventing a value, and `connectorKey` is what
   * actually identifies the lineage a version belongs to.
   */
  connector_manifest_versioned: ['manifestId', 'connectorKey', 'version', 'sourceRoute'],
  probe_completed: ['connectionId', 'stage', 'objectsFound'],
  connector_build_tested: ['buildId', 'round', 'objectsRead', 'objectsFailed'],
  connector_build_connected: ['buildId', 'connectionId', 'manifestId'],
  connector_fields_listed: ['connectionId', 'manifestId', 'objectCount', 'added'],
  probe_failed: ['connectionId', 'stage', 'reason'],
  mapping_confirmed: ['connectionId', 'manifestId', 'objectCount'],
  trust_tier_promoted: ['connectionId', 'from', 'to'],
  writes_enabled: ['connectionId', 'manifestId'],

  /*
   * `credential_unwrapped` IS THE ONE A SECURITY REVIEW READS FIRST. The
   * mediator already refuses to unwrap without a reason from a closed enum;
   * requiring it here is what makes the log answer "why was this secret touched"
   * rather than only "it was".
   *
   * ONE EVENT FOR BOTH OUTCOMES, with `outcome` in the detail. The secret is
   * unwrapped before the work that uses it, so a failure afterwards is still an
   * access that happened — recording only the successes would leave an attacker
   * probing with a stolen sealed value no trace at all.
   */
  credential_unwrapped: ['connectionId', 'reason', 'outcome'],
  /*
   * THE SAME QUESTION FOR A WATCHED LOCATION, WHICH IS NOT A CONNECTION. Its
   * credential belongs to a source, and writing the source's id where a
   * connection's belongs would send a reviewer to look for a connection that
   * does not exist. A review of credential access reads both events.
   */
  watch_credential_unwrapped: ['sourceId', 'reason', 'outcome'],
  /* §13 — "the row a security reviewer asks for": which words were accepted. */
  extraction_carveout_acknowledged: ['disclosureVersion'],
  /* §5 — "Confirmations are recorded with the confirming membership and are visible in the audit trail." */
  extraction_confirmed: ['fileId', 'previousMethod'],
  oauth_scope_missing: ['connectionId', 'requested', 'granted'],
  token_refresh_failed: ['connectionId', 'reason'],

  /*
   * A HALT MEANS EVERY QUERY THROUGH THIS CONNECTION IS NOW REFUSED, so the row
   * has to say what stopped it. Without the cause it is indistinguishable from
   * an outage, and somebody re-enables it without fixing anything.
   */
  connection_halted: ['connectionId', 'cause'],
  heal_halted: ['connectionId', 'changeKind', 'objectOrField'],

  /*
   * §9.2: an authorisation is a window, not standing permission, so the row
   * that records granting one has to say what it covered and when it stops.
   * "A scan was authorised" without the ranges is not reviewable.
   */
  scan_authorised: ['authorisationId', 'agentId', 'ranges', 'methods', 'expiresAt'],

  /*
   * THE HIGHEST-VOLUME EVENT IN THE SYSTEM DURING A SCAN, and the one a security
   * review actually wants. Per host, naming the authorisation it ran under —
   * without that, the log says something was contacted and cannot say by whose
   * permission.
   */
  host_probed: ['authorisationId', 'runId', 'host', 'method'],

  finding_promoted_to_connector: ['findingId', 'connectionId'],
  view_opened_with_reduced_permissions: ['viewId', 'openerMembershipId', 'droppedElements'],

  /*
   * AUTH rev 7 — a view that changed hands because its owner did not stay.
   *
   * BOTH SIDES AND THE RULE THAT PICKED THEM. "Why do I have this view" has
   * three possible answers — the admin of their primary scope, the nearest admin
   * above one of their scopes, or a super admin because nothing else applied —
   * and a row naming only the receiver cannot distinguish a correct transfer
   * from a view handed to the wrong subtree.
   */
  view_transferred: ['viewId', 'transferredTo', 'transferredFrom', 'reason', 'route'],
  /*
   * AND WHAT WAS DECIDED, which is the accountability the suspension exists to
   * create: three colleagues either kept their access because somebody said so,
   * or lost it because somebody said so.
   */
  view_transfer_reviewed: ['flagId', 'viewId', 'decision'],
};

export function validate(entry: AuditEntry): { ok: boolean; missing: string[] } {
  const required = REQUIRED_DETAIL[entry.event] ?? [];
  const missing = required.filter((key) => !(key in entry.detail));
  return { ok: missing.length === 0, missing };
}

/**
 * Write an audit row.
 *
 * IT THROWS WHEN REQUIRED DETAIL IS MISSING, rather than writing a row that
 * cannot be interpreted. A half-populated audit row is worse than none: it
 * appears in the count, satisfies the reviewer's filter, and answers nothing.
 *
 * IT DOES NOT SWALLOW SINK FAILURES. A common instinct is to log-and-continue so
 * an audit problem never breaks a user action. That is exactly backwards for the
 * events here: an admin delegation that succeeded without a record is an
 * unattributable privilege change. The caller decides, in the same transaction as
 * the thing being recorded.
 */
export async function record(sink: AuditSink, entry: AuditEntry): Promise<void> {
  const { ok, missing } = validate(entry);
  if (!ok) {
    throw new Error(
      `Audit event "${entry.event}" is missing required detail: ${missing.join(', ')}. ` +
        `These fields are what make the event reviewable later.`,
    );
  }
  await sink.write(entry);
}

/* ── What of an audit row's `detail` may be published ─────────────────────── */

/**
 * The keys a reviewer is allowed to see.
 *
 * ── An allow-list, because `present.ts` says so and is right ───────────────
 *
 * "ALLOW-LIST, NEVER A DENY-LIST… the failure mode of a forgotten deny-list is
 * silently publishing a secret, while the failure mode of a forgotten allow-list
 * entry is a missing field somebody notices immediately."
 *
 * `detail` is `jsonb` written from a hundred and eighty places across twenty
 * services. Passing it through whole — which is what the first version of the
 * audit route did — is neither list: it is an open channel from anywhere in the
 * codebase to an HTTP response, and the next person to write
 * `detail: { sampleRow }` publishes it without ever opening the presenter.
 *
 * ── It lives here rather than in the presenter, deliberately ───────────────
 *
 * Beside the events and `REQUIRED_DETAIL`, because the person adding an event
 * and choosing its detail keys is already editing this file. A list kept in
 * `present.ts` is a list they would never see, and an allow-list nobody updates
 * fails closed into a trail with holes in it.
 *
 * A KEY THAT IS NEITHER PUBLISHED NOR WITHHELD IS A BUILD FAILURE. The test
 * beside this scans every audit write in `src` and refuses an unclassified key,
 * so adding one is a decision somebody makes rather than a default they inherit.
 *
 * ── EVERYTHING `REQUIRED_DETAIL` DEMANDS IS PUBLISHED, WITHOUT EXCEPTION ───
 *
 * The first version of this list had eighteen holes in it, and they were the
 * worst eighteen available: `granterMembershipId`, `granterScopePath`,
 * `targetScopePath` and `permissions` on a delegation, `oldPath` on a scope
 * move. Those are exactly the keys `REQUIRED_DETAIL` refuses to write the event
 * WITHOUT — the system insisted on recording them and the reviewer could not
 * see one of them, so `admin_delegated` came back as a target id and four
 * entries in `omitted`.
 *
 * They were missing because the scan that builds this could not see ES6
 * SHORTHAND (`detail: { granterMembershipId }` has no colon) or a `detail` that
 * is a ternary. Both are fixed, and the invariant is now a test: a key that is
 * required is never withheld.
 */
export const PUBLISHED_DETAIL: ReadonlySet<string> = new Set([
  /*
   * MANIFEST-V2 §3.4 — the agent. `hosts` is exactly what an admin confirmed a
   * connection may reach inside the network, which is the question a review of
   * an agent asks; `hostname` is the machine the agent reported running on.
   * Neither is a credential or a record.
   */
  'hosts', 'hostname',
  /*
   * §9.2 — `origins` are the scheme, host and port a credential may be sent to:
   * addresses, never a credential. `statements` is how many SQL statements were
   * pinned, a count; the text is the connector's and lives with it.
   */
  /* When a credential lapses and how that is known — a certificate, a token's exp, a declared lifetime. */
  'stage', 'expiresAt', 'source', 'autoAdoptPrebuilt',
  /* A connector build: which, which round, and how many objects read or failed. Counts, never records. */
  'buildId', 'round', 'objectsRead', 'objectsFailed',
  'origins', 'statements', 'originsAdded', 'originsRemoved', 'statementsChanged', 'fromManifestId', 'toManifestId',
  /* The NAMES of a connection's parameters — host, tenant, region — never their
     values, which stay on the connection and are refused if they look secret. */
  'parameters',
  /* §7.3 — an organisation's own calendar. Configuration, not customer data,
     and the previous values are what let a past figure be interpreted. */
  'timeZone', 'yearStartsInMonth', 'previousTimeZone', 'previousYearStartsInMonth',
  /*
   * An uploaded logo, as the bytes actually were.
   *
   * `mismatch` IS THE INTERESTING HALF. It says the uploader's declared content
   * type disagreed with what the file turned out to be, which is the one thing
   * an upload review is looking for — and it is meaningless without
   * `declaredContentType` beside it to say what was claimed. `bytes` is a size,
   * which is a fact about the file rather than about its contents.
   */
  'declaredContentType', 'mismatch', 'bytes',
  /*
   * §1 — SCIM. `externalId` is the directory's own opaque id for a person, and
   * it is the only thing that can answer "which directory user was this" when
   * somebody asks why an account appeared or went quiet. Less revealing than
   * `email`, which this list already publishes. `groupId` is one of ours.
   */
  'externalId', 'groupId',
  /*
   * §10 — Siloes. Every one of these is a count, a window, a concept id or a
   * field NAME. No transition value reaches the audit trail: the point of
   * keeping the transition record narrow is undone if the log widens it again.
   */
  'siloId', 'retentionDays', 'fields', 'previousFields', 'transitionsRemoved',
  'baselinesRemoved', 'detectorsAffected', 'captured', 'swept', 'scope',
  /* A purge's receipt id ties the audit row to the receipt it corroborates; the
     entity reference is what findings already publish; `siloDisabled` is §9's
     "disable and purge" said rather than discovered. */
  'receiptId', 'entityRef', 'siloDisabled',
  /* The approval chain, and which version of the storage disclosure was agreed to. */
  'approvalRequestId', 'approvalsRequired', 'disclosureVersion',
  /*
   * Mutations. Counts, a tier and a digest — never a value. `operation` and
   * `resolution` are the two words of the manifest that are not data; `digest`
   * is SHA-256 of the preview, which identifies a diff without containing it.
   */
  'operation', 'resolution', 'entities', 'records', 'excluded', 'unchanged',
  'consequences', 'uncounted', 'bulk', 'digest',
  /* §9 — approval policy terms and a chain's progress. Configuration and counts. */
  'requiredRoleId', 'requiredRoleIds', 'allowSelfApproval', 'separateExecution',
  'expiresAfterHours', 'approvalsReceived', 'sequence',
  /* §10 — which records took a write, by identifier, and the counts. */
  'refs', 'phase', 'applied', 'failed',
  /* §13 — which change a revert undoes, and how many fields it found moved or left alone. */
  'revertsMutationId', 'conflicts', 'missing', 'kept',
  /* A field policy's effect: deny, mask or redact. */
  'effect',
  /*
   * §12 — what an organisation decided to call a concept, and what it called it
   * before. NOT `value`/`previousValue`: those two names are reserved by the
   * Silo egress check for what a customer record said, and this is a word an
   * administrator chose. Distinct names keep that check as narrow as it is.
   */
  'term', 'previousTerm',
  /* The receipt window before a change to it. */
  'previousRetentionDays',
  /*
   * Billing. A plan, a seat count, a term, a discount and an amount in pence:
   * what was bought, never who paid or with what.
   */
  'plan', 'previousPlan', 'seats', 'term', 'discountPercent', 'amountPence', 'billedUntil',
  /* §4 — allowances and purchases: quantities, never a price anybody paid with. */
  'granted', 'quantity', 'auto', 'weight', 'periodStart', 'periodEnd', 'packTokens', 'packPricePence',
  /* §6 — a Silo's size, what its questions scanned, what we were charged and
     which rate card applied. Sizes and money, no row and no field name. */
  'bytesHeld', 'bytesScanned', 'providerCostPence', 'residency',
  /*
   * Automations §13 — which check, and what it is scheduled to do.
   *
   * NEVER A VALUE IT READ. A run row says how many records matched, never
   * which: `records` is already published as a count, and an automation that
   * leaked the rows it found into the trail would be a way around every
   * storage promise the product makes.
   */
  'automationId', 'schedule', 'timeZone',
  /* §4 — which escalation, never what it was about: the reason is the run's
     own words and lives on the run, where it is already bounded. */
  'escalationId',
  /* §5 — which authorisation a write ran under. Not its bounds again: those are
     on the authorising row, where they were decided. */
  'authorisationId',
  /*
   * Files §9 — which document, and what it was produced from. Never its
   * contents: the bytes are in the object store and the trail stays narrow.
   *
   * `folderId` CAME AND WENT AND CAME BACK, which is the list working. It was
   * published before folders existed, refused because nothing wrote it, and
   * published again once `file_moved` did. A folder is an arrangement and not a
   * boundary (§2), so naming one discloses nothing about access.
   */
  'fileId', 'sourceKind', 'folderId',
  /* §5 and §6 — which outcome a document got, and what its removal reached.
     `detectorsAffected` is already published; these are counts and a scope. */
  'outcome', 'rowsRemoved', 'detectorsAffected',
  /* Simulation §2 — which edge, between which concepts, and on what evidence.
     Concept ids and a source word: no lead time a competitor could read as
     operational intelligence, and no entity at all. */
  'edgeId', 'fromConceptId', 'toConceptId', 'source', 'edgeKind',
  'leadTimeValue', 'leadTimeUnit',
  /* Simulation §5 and §9 — a scenario, a run, the graph it ran against, and
     how much it reached. Identifiers and counts: no entity is named here, and
     the records a run found live in `simulation_results` behind the same
     tenant policy as every other answer. */
  'scenarioId', 'runId', 'graphVersion', 'affected', 'failedConceptId',
  'atConceptId', 'hop', 'bound', 'mode', 'sharedWith', 'entered', 'left',
  /*
   * Rendering §11 — a drawing decision and the structure behind it. `signals`
   * is counts, booleans and field PATHS: schema rather than data, and the same
   * strings already in `field_policies` and every mutation's audit row. There
   * is nowhere in a `Signals` to put a figure, which is enforced by the schema
   * at the door rather than trusted here.
   */
  'resultRef', 'archetype', 'alternatives', 'overriddenTo', 'signals', 'representation',
  /* §5 and §6 — which field was drilled into and which flag was opened. A
     field path and a flag's kind: schema and a word from a closed set. */
  'flagKind', 'records',
  /* §4.3 — "Sample size for every edge on the path, always shown." A count of
     completed gaps, which is a statistic about timing rather than about what
     any of the records said. */
  'sampleCount',
  /* Import §5 — how many values a file produced that carry a flag. */
  'flagged',
  /* Import §5 — what a confirmed value's method was before a person confirmed it. */
  'previousMethod',
  /* Import: which source, definition and file, and counts — never a value read out of one. */
  'sourceId', 'definitionId', 'fileId', 'rowsExtracted', 'rowsRejected', 'failureCode', 'rowsRemoved', 'filesRemoved',
  'copiesRemoved', 'history',
  /* Siloes (136) — how many copies of a kept concept the sweep removed, and whether past copies are kept: a count and a yes or no. */
  /* §3.4 — a threshold that moved, and the evidence that moved it. Counts, not
     values: how many people confirmed and how many set aside. */
  'previousValue', 'signalCount', 'noiseCount', 'value',
  /* Which session was ended, and by whom: an id, and no token or address with it. */
  'sessionId',
  /*
   * AUTH rev 7 — an inherited view: who it went to, who it came from, which
   * clause of the transfer rule chose them, the flag, and what the review did to
   * the shares.
   *
   * TWO MEMBERSHIP IDS AND A WORD FROM A CLOSED SET. The trail already publishes
   * `targetMembershipId` and `granteeId`, so naming a membership is not a
   * disclosure — and an inheritance a reviewer cannot trace from one person to
   * another is the one thing this event exists to make traceable. The share
   * figures are counts, as `sessionsRevoked` is.
   */
  'transferredTo', 'transferredFrom', 'route', 'flagId',
  'sharesSuspended', 'sharesRestored', 'sharesRevoked', 'cronsPaused',
  'access', 'action', 'added', 'agentId', 'kind', 'outcome', 'questionLength', 'aliasId', 'canonicalField', 'sourceField', 'objectName', 'appliedFloor', 'approverMembershipId',
  'attempt', 'attempts', 'authorisationId', 'authorityId', 'canWrite',
  'cause', 'change', 'changeKind', 'compared', 'agreed', 'borneOutBy', 'conceptId', 'concepts',
  'confidence', 'configuredPolicy', 'connectionId', 'connections', 'connectorKey',
  'coverage', 'crossConceptSkipped', 'decision', 'designationId',
  'detector', 'direction', 'disabled', 'disposition', 'domains', 'droppedElements',
  'effectiveAt', 'email', 'enabled', 'examined', 'expiresAt', 'fieldPath',
  'findingId', 'findingsRead', 'forkedFrom', 'from', 'grantId', 'granted',
  'grantedAtScopePath', 'grantedScopes', 'grantee', 'granteeId', 'granteeType',
  'granterMembershipId', 'granterScopePath', 'grantsSilenced', 'host',
  'inputTokens', 'invitationId', 'issuer', 'keyId', 'lockoutSeconds', 'manifestId',
  'mapId', 'markingId', 'measure', 'method', 'methods', 'missingScopes',
  'modelVersion', 'mutationId', 'name', 'newPath', 'objectCount', 'objectOrField',
  'objectsFound', 'oldPath', 'omitted', 'openerMembershipId', 'originalGranterMembershipId',
  'outcome', 'outputTokens', 'pairId', 'parentId', 'path', 'permissions',
  'population', 'previousReason', 'principalId', 'proposalId', 'proposedBy',
  'proposedName', 'provider', 'providerId', 'raised', 'ranges', 'ranked',
  'rankingId', 'reason', 'removed', 'requested', 'requestedScopes', 'revokerMembershipId',
  'role', 'roleId', 'runId', 'sampled', 'scopeId', 'scopePath', 'scopeTypeId',
  'seatId', 'seatReleased', 'sessionsRevoked', 'shareId', 'sourceRoute',
  'stage', 'strategy', 'subject', 'targetMembershipId', 'targetScopePath',
  'to', 'unresolved', 'version', 'via', 'viewId',
]);

/**
 * Keys written to the trail on purpose and not handed to a reader.
 *
 * EACH NAMES WHY. A withheld key is a judgement, and one with no reason beside
 * it is indistinguishable from an oversight.
 */
export const WITHHELD_DETAIL: Readonly<Record<string, string>> = {
  lastFour:
    'Four characters of a live credential to a customer\'s own system. It is ' +
    'written so an audit row can be tied to the credential a screen shows as ' +
    'dots, and the screen showing it requires access to that CONNECTION — a ' +
    'different permission from reading the trail. "They could see it elsewhere" ' +
    'is an argument about a reader who holds a grant this one need not.',
};
