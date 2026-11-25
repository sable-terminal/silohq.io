// The AI FDE's fixed vocabulary (spec 49, 52): its roles, what each role's tools need, the
// forbidden set no FDE principal may ever hold, the proposal kinds and the existing
// permission each kind's decider must also hold, and the engagement log's events.

/** 52.8: every task, model call, proposal, decision, refusal, limit and stop. */
export const FDE_EVENTS = [
  // 73.5, 73.9 (D207): the engagement cost report as it stood when the engagement ended.
  'engagement_cost_reported',
  'fde_engagement_started', 'fde_engagement_paused', 'fde_engagement_resumed', 'fde_engagement_stopped', 'fde_engagement_handed_over',
  'fde_engagement_closed', 'fde_principal_created', 'fde_principal_revoked', 'fde_stage_entered', 'fde_stage_passed', 'fde_stage_failed',
  'fde_stage_exit_confirmed', 'fde_task_started', 'fde_task_completed', 'fde_task_failed', 'fde_model_call', 'fde_proposal_created',
  'fde_proposal_accepted', 'fde_proposal_edited', 'fde_proposal_rejected', 'fde_proposal_deferred', 'fde_proposal_withdrawn',
  'fde_proposals_group_accepted', 'fde_confirmation_session_started', 'fde_confirmation_session_completed', 'fde_ceiling_refusal',
  'fde_limit_reached', 'fde_escalation_raised', 'fde_escalation_resolved', 'fde_engineer_assigned', 'fde_engineer_removed',
  // The customer's engagement owner named (decision 2026-11-14): who confirms stage exits.
  'fde_owner_named',
  // Not in 52.8: a system listed for the engagement with its documentation (51.2 to 51.4), and withdrawn.
  'fde_system_listed', 'fde_system_withdrawn',
] as const;
export type FdeEvent = (typeof FDE_EVENTS)[number];

export const FDE_ROLES = ['survey', 'integration', 'ontology', 'action', 'application', 'simulation', 'reliability'] as const;
export type FdeRole = (typeof FDE_ROLES)[number];

/**
 * 52.1: never on an FDE principal. The database refuses it on fde_principals.tool_permissions
 * and on any role an FDE principal holds (fde.forbidden_permissions); policy subtracts it again.
 */
export const FDE_FORBIDDEN_PERMISSIONS = [
  'mutation.approve', 'mutation.execute', 'automation.mutate', 'automation.execute',
  'silo.enable', 'silo.create', 'silo.manage', 'silo.purge', 'silo.import',
  'clearance.grant', 'marking.manage', 'marking.declassify', 'ontology.mark',
  'admin.delegate', 'member.invite', 'service_principal.manage', 'connection.grant',
  'discovery.manage', 'billing.manage', 'billing.view', 'tokens.purchase', 'seat.allocate', 'seat.release',
  'contract.manage', 'payment.record', 'fde.engage', 'fde.confirm',
] as const;

/** What each role's tools need (49.3): read, derive and propose. Never a decision. */
export const ROLE_TOOL_PERMISSIONS: Readonly<Record<FdeRole, readonly string[]>> = {
  survey: ['estate.view', 'agent.view', 'connection.create'],
  integration: ['connector.build', 'connection.create'],
  ontology: ['ontology.view', 'ontology.propose', 'ontology.branch'],
  action: ['ontology.view', 'mutation.propose'],
  application: ['ontology.view', 'recognition.run', 'app.create'],
  simulation: ['ontology.view', 'graph.propose', 'simulation.run'],
  // Re-profiling a connection to see drift (51.11) is ontology.propose; reading profiles, ontology.view.
  reliability: ['connection.create', 'ontology.view', 'ontology.propose'],
};

export const PROPOSAL_KINDS = [
  'discovery_finding', 'estate_entry', 'connector_manifest', 'connector_mapping', 'write_enablement', 'object_type', 'link_type',
  'interface', 'resolution_pair', 'field_authority', 'field_alias', 'time_field', 'action_type', 'studio_app', 'object_view_layout',
  'dashboard', 'cron_notify', 'detector_configuration', 'dependency_edge', 'heal_review', 'reliability_finding',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** 49.3: the proposal kinds each role emits; a task's proposal of another role's kind is refused. */
export const ROLE_PROPOSAL_KINDS: Readonly<Record<FdeRole, readonly ProposalKind[]>> = {
  survey: ['discovery_finding', 'estate_entry'],
  integration: ['connector_manifest', 'connector_mapping', 'write_enablement'],
  ontology: ['object_type', 'link_type', 'interface', 'resolution_pair', 'field_authority', 'field_alias', 'time_field'],
  action: ['action_type'],
  application: ['studio_app', 'object_view_layout', 'dashboard', 'cron_notify', 'detector_configuration'],
  simulation: ['dependency_edge'],
  reliability: ['heal_review', 'reliability_finding'],
};

/** 52.2: the existing permission a decider holds besides fde.confirm (chapter 76 identifiers). */
export const KIND_PERMISSION: Readonly<Record<ProposalKind, string>> = {
  discovery_finding: 'discovery.review',
  // Stage 1's scope list is the engaging administrator's decision (50.4).
  estate_entry: 'fde.engage',
  connector_manifest: 'connection.create',
  connector_mapping: 'connection.create',
  write_enablement: 'mutation.policy',
  object_type: 'ontology.confirm',
  link_type: 'ontology.confirm',
  interface: 'ontology.confirm',
  field_alias: 'ontology.confirm',
  time_field: 'ontology.confirm',
  resolution_pair: 'resolution.confirm',
  field_authority: 'authority.declare',
  action_type: 'mutation.policy',
  studio_app: 'app.publish',
  object_view_layout: 'app.publish',
  dashboard: 'app.publish',
  cron_notify: 'automation.create',
  detector_configuration: 'recognition.configure',
  dependency_edge: 'graph.confirm',
  heal_review: 'connector.heal_review',
  reliability_finding: 'connector.heal_review',
};

/** 52.3: never accepted as a group: each changes what a value is, what can be written, or what every simulation concludes. */
export const NEVER_GROUP_ACCEPTED: ReadonlySet<ProposalKind> = new Set(['field_authority', 'write_enablement', 'action_type', 'dependency_edge']);

/** 53.2: the only kinds a deployment engineer may be given fde.confirm for. */
export const TECHNICAL_KINDS: ReadonlySet<ProposalKind> = new Set(['connector_manifest', 'connector_mapping', 'heal_review']);

export const EVIDENCE_TYPES = [
  'foreign_key', 'field_profile', 'value_overlap', 'documentation', 'probe', 'sandbox_cycle', 'history', 'organisation_statement',
] as const;

export const ERROR_SEMANTICS = ['auth', 'rate_limit', 'not_found', 'upstream', 'bounds', 'schema', 'unsupported_transport', 'ceiling', 'limit'] as const;
export type ErrorSemantic = (typeof ERROR_SEMANTICS)[number];
