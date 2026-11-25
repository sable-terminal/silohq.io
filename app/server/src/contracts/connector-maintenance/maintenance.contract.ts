// connector-maintenance: the weekly re-check, drift detection and self-heal (spec 17.3 to 17.5;
// design: connect.probe_runs stage recheck, connect.heal_proposals).
//
// A re-check of a connection runs the conformance suite on its version (read, pagination,
// filter pushdown, error) and observes each object's structure from a live sample
// (connect-runtime's observeObject), then compares what the source does with what the
// manifest declares. Findings are structure and counts only, never a value. Per change:
//
// | Change                          | Response                                                    |
// |---------------------------------|-------------------------------------------------------------|
// | Field renamed                   | A repair (a new version), sandbox-tested, then applied      |
// | Field changed meaning           | Halt and report                                             |
// | New field                       | A mapping proposal, applied only when a person accepts it   |
// | Object disappeared              | Halt                                                        |
// | Type changed                    | Halt; where it only widens (integer to number), a proposal  |
// | Declared pushdown not honoured  | A version without it, sandbox-tested, then applied          |
//
// A rename is accepted only where the old field is absent, exactly one new field is present,
// its type and format match, and its sample distribution (presence, distinctness, length) is
// consistent with the old field's at the last re-check; otherwise it is a change of meaning.
// A repair is a new manifest version, never an edit, and is applied to the connection only
// when a conformance run on it passes. Repair proposals are metered (2 tokens, repair_proposal)
// when a person asked for the re-check; the weekly re-check is a scheduled run and never is.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const RECHECK_TRIGGERS = ['weekly', 'manual', 'self_heal'] as const;
export type RecheckTrigger = (typeof RECHECK_TRIGGERS)[number];

export const CHANGE_KINDS = ['rename', 'semantic', 'new_field', 'object_removed', 'type_changed', 'pushdown_lost'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** What a proposal leads to: auto_applied and applied name the new version. */
export const DISPOSITIONS = ['auto_applied', 'awaiting_review', 'applied', 'halted', 'rejected'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** One change a repair makes to the manifest. Names, paths, types and operators only. */
export const manifestChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename_field'), object: z.string(), field: z.string(), fromPath: z.string(), toPath: z.string() }),
  z.object({ op: z.literal('widen_type'), object: z.string(), field: z.string(), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('add_field'), object: z.string(), field: z.string(), type: z.string(), path: z.string() }),
  z.object({ op: z.literal('remove_filter'), object: z.string(), field: z.string(), ops: z.array(z.string()) }),
  z.object({ op: z.literal('remove_sort'), object: z.string(), field: z.string() }),
  z.object({ op: z.literal('remove_aggregate'), object: z.string(), function: z.string() }),
]);
export type ManifestChange = z.infer<typeof manifestChange>;

/** A drift a re-check found, against the manifest's declaration. */
export const drift = z.object({
  kind: z.enum(['field_absent', 'rename', 'meaning_changed', 'type_changed', 'type_widened', 'new_field', 'object_removed', 'pushdown_lost']),
  object: z.string(),
  field: z.string().nullable(),
  /** Codes and counts: what was expected and what was seen. */
  detail: z.string().max(300),
});
export type Drift = z.infer<typeof drift>;

export const healProposalView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  fromManifestId: z.uuid(),
  changeKind: z.enum(CHANGE_KINDS),
  /** The changes the repair makes; empty for a halt, which repairs nothing. */
  changes: z.array(manifestChange),
  /** The drift that raised it. */
  drift: z.array(drift),
  disposition: z.enum(DISPOSITIONS),
  /** The repaired version, once created: tested before it is applied. */
  candidateManifestId: z.uuid().nullable(),
  sandbox: z.object({
    status: z.enum(['not_run', 'running', 'passed', 'failed']),
    conformanceRunId: z.uuid().nullable(),
    /** Codes only: why it was not run, or which classes failed. */
    reason: z.string().max(300).nullable(),
  }),
  appliedManifestId: z.uuid().nullable(),
  /** Whether the repair was charged, and how (a ledger row, or why not). */
  charge: z.enum(['not_metered', 'charged', 'never_metered', 'refused', 'pending']),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type HealProposalView = z.infer<typeof healProposalView>;

export const recheckView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  manifestId: z.uuid(),
  trigger: z.enum(RECHECK_TRIGGERS),
  status: z.enum(['running', 'completed', 'failed']),
  conformanceRunId: z.uuid().nullable(),
  /** The conformance gate on the version: read, pagination and error passed. */
  verified: z.boolean().nullable(),
  objects: z.array(z.object({
    object: z.string(),
    observable: z.boolean(),
    reason: z.string().nullable(),
    records: z.int(),
  })),
  drift: z.array(drift),
  /** The connection was halted by this re-check. */
  halted: z.boolean(),
  /** last_healthy_at was set: the suite passed and nothing drifted. */
  healthy: z.boolean(),
  healProposalIds: z.array(z.uuid()),
  /** Classified errors, codes only. */
  errors: z.array(z.string().max(200)),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type RecheckView = z.infer<typeof recheckView>;

const connectionId = z.strictObject({ connectionId: z.uuid() });

export const requestRecheck = defineContract({
  service: 'connector-maintenance', name: 'requestRecheck', method: 'POST', path: '/v1/connections/:connectionId/rechecks',
  callers: ['gateway'],
  // A re-check reads the source many times and may propose a metered repair: a retry returns the first.
  context: 'organisation', idempotency: 'keyed',
  params: connectionId,
  response: recheckView,
  // It continues after the reply; read it back to see it complete.
  status: 202,
  maxBodyBytes: 1_024,
});

/**
 * A runtime self-heal (spec 17.3): a service that saw a source refuse or contradict the
 * manifest asks for a re-check. At most one runs per connection, and none starts within
 * SELF_HEAL_QUIET_MINUTES of the last, so a failing source is not hammered.
 */
export const reportSourceDrift = defineContract({
  service: 'connector-maintenance', name: 'reportSourceDrift', method: 'POST', path: '/v1/connections/:connectionId/drift-reports',
  callers: ['connect-runtime', 'executor', 'actions', 'change-stream', 'state-plane', 'conformance'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    /** Codes: what the caller saw. */
    signal: z.enum(['source_error', 'type_mismatch', 'object_missing', 'auth', 'pushdown_mismatch']),
  }),
  response: z.object({ started: z.boolean(), recheckId: z.uuid().nullable() }),
  status: 202,
  maxBodyBytes: 1_024,
});

export const SELF_HEAL_QUIET_MINUTES = 15;

export const getRecheck = defineContract({
  service: 'connector-maintenance', name: 'getRecheck', method: 'GET', path: '/v1/rechecks/:recheckId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ recheckId: z.uuid() }),
  response: recheckView,
});

export const listRechecks = defineContract({
  service: 'connector-maintenance', name: 'listRechecks', method: 'GET', path: '/v1/connections/:connectionId/rechecks', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  response: z.object({ rechecks: z.array(recheckView) }),
});

export const listHealProposals = defineContract({
  service: 'connector-maintenance', name: 'listHealProposals', method: 'GET', path: '/v1/heal-proposals', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    connectionId: z.uuid().optional(),
    disposition: z.enum(DISPOSITIONS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ proposals: z.array(healProposalView) }),
});

export const getHealProposal = defineContract({
  service: 'connector-maintenance', name: 'getHealProposal', method: 'GET', path: '/v1/heal-proposals/:proposalId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ proposalId: z.uuid() }),
  response: healProposalView,
});

/**
 * connector.heal_review (or the connection's owner): accept or reject a proposal awaiting
 * review. Accepting creates the repaired version if it does not exist, tests it in the
 * sandbox and applies it when the run passes; the answer comes at once and the test continues.
 */
export const decideHealProposal = defineContract({
  service: 'connector-maintenance', name: 'decideHealProposal', method: 'POST', path: '/v1/heal-proposals/:proposalId/decision',
  callers: ['gateway', 'fde-orchestrator'],
  // A decision moves the proposal once; a second is refused, not reapplied.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ proposalId: z.uuid() }),
  body: z.strictObject({ decision: z.enum(['accept', 'reject']) }),
  response: healProposalView,
  status: 202,
  maxBodyBytes: 1_024,
});
