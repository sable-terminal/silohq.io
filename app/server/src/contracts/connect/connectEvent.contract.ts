// The Connect audit events (spec 14.10, 15.6, 61.9), as they cross from the connect services
// to the audit ledger: written to the outbox in the transaction that made the change,
// published on audit.events by the outbox relay, stored in audit.audit_events by the audit
// service. References and counts only: never a secret, a last four, a record value or a
// manifest body.
//
// The message is the audit service's audit_event (contracts/audit/auditEvent.contract.ts),
// whose catalogue lists these names. The schema here is what a connect service supplies;
// services/connect-registry/connectEvents.service.ts maps it onto audit_event.

import { z } from 'zod';

export const CONNECT_EVENTS = [
  // spec 14.10
  'connector_created', 'connector_manifest_versioned', 'manifest_expression_rejected', 'connection_created', 'connection_granted',
  'connection_grant_revoked', 'connection_ownership_transferred', 'policy_authority_delegated', 'policy_authority_revoked',
  // spec 44.8: every change of a connection's policy authority mode, from and to.
  'policy_authority_changed',
  'connection_halted', 'connection_resumed', 'connection_revoked', 'connection_parameters_changed',
  // spec 15.6 and 61.9 (credential_unwrapped is the iam.credential_unwraps ledger itself)
  'credential_sealed', 'credential_rotated', 'credential_revoked', 'oauth_flow_started', 'oauth_flow_completed', 'oauth_flow_expired', 'oauth_scope_missing',
  'oauth_client_registered', 'oauth_client_revoked', 'token_refreshed', 'token_refresh_failed',
  // spec 15.6: a provider's discovery document read (15.4 step 1).
  'oauth_metadata_discovered',
  // status moves that spec 17 names through conformance; recorded here until it exists
  'connection_probing', 'connection_verified', 'connection_activated', 'connection_renamed',
  // spec 17.5
  'conformance_run_started', 'conformance_run_completed', 'conformance_test_failed',
  // spec 16.3, 16.6: the build routes
  'connector_build_started', 'connector_build_stage_failed', 'probe_started', 'probe_completed', 'probe_failed', 'mapping_confirmed',
  'connection_version_changed',
  // private links (decision 2026-11-09; not in spec chapter 77)
  'private_link_added', 'private_link_removed',
  // outbound webhook targets (spec 20.8; revoked is recorded too, D64)
  'outbound_webhook_registered', 'outbound_webhook_revoked',
  // industrial endpoints and writable points (spec 20.8)
  'industrial_endpoint_created', 'industrial_endpoint_untrusted', 'opcua_insecure_exception_recorded', 'writable_point_declared', 'writable_point_risk_raised',
  // An endpoint's verification found the server trusts the application certificate (D186; not in spec 20.8, read with industrial_endpoint_untrusted).
  'industrial_endpoint_verified',
  // The agent took a connection's signed actuation allow-list (spec 47.8).
  'allowlist_delivered_to_agent',
  // Silo Agent (spec 10.9)
  'agent_pool_created', 'agent_enrolment_token_issued', 'agent_enrolled', 'agent_revoked', 'agent_unhealthy', 'agent_recovered', 'agent_certificate_renewed',
  // Spec 10.6: what the agent's spool dropped at its bound, or a resumed reader found missing (counts, times, positions).
  'agent_spool_gap',
  // Spec 10.9, read first: the agent refused a write the cell did not sign, or signed for something else.
  'agent_write_grant_refused', 'agent_target_refused',
  // Spec 10.9: an agent came onto another version; an agent refused an update, or undid one that failed.
  'agent_updated', 'agent_update_refused',
  // A pool's update policy set, and a version approved under it (spec 10.7; not in chapter 77).
  'agent_update_policy_set', 'agent_update_approved',
] as const;
export type ConnectEventName = (typeof CONNECT_EVENTS)[number];

export const connectEventSchema = z.strictObject({
    event: z.enum(CONNECT_EVENTS),
    membershipId: z.uuid().nullable(),
    servicePrincipalId: z.uuid().nullable(),
    resourceType: z.enum([
      'connector', 'manifest', 'connection', 'credential', 'oauth_client', 'conformance_run', 'private_link',
      'agent_pool', 'agent',
    ]),
    resourceId: z.uuid(),
    /** Identifiers, closed-set reasons and counts only. */
    detail: z.record(z.string().regex(/^[a-z][a-z_]*$/), z.union([z.string().max(200), z.number(), z.boolean()])),
});

export type ConnectEvent = z.infer<typeof connectEventSchema>;
