// The audit service's read endpoints (spec 63.5, 63.7): the Governance audit view and
// export, through the gateway or the admin portal.
//
// Every read is decided by the policy service: audit.read to view, audit.export to export.
// A reader whose grant sits on a scope reads the events about that scope and the scopes
// beneath it, and must name the scope; reading the whole organisation, the auth events or
// the chain needs the permission organisation-wide.
//
// The chain endpoint returns a run of the organisation's hash chain with the link it
// follows and the result of verifying it, so a reviewer can check that no row was changed,
// removed or reordered (spec 13.4, 63.1); the seals cover whole closed partitions. Hashes
// travel as lowercase hex.

import { z } from 'zod';
import { auditEventSchema } from '../../schemas/audit/auditEvent.schema.ts';
import { authEventSchema } from '../../schemas/audit/authEvent.schema.ts';
import { chainHeadSchema } from '../../schemas/audit/chainHead.schema.ts';
import { partitionSealSchema } from '../../schemas/audit/partitionSeal.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

const READERS = ['gateway', 'admin-portal'] as const;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const snake = z.string().regex(/^[a-z][a-z0-9_]*$/).max(63);
/** Opaque: where the previous page ended. */
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const seq = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

export const auditEventView = auditEventSchema.omit({ ipHash: true, prevHash: true, rowHash: true }).extend({
  prevHash: hex64,
  rowHash: hex64,
});
export type AuditEventView = z.infer<typeof auditEventView>;

export const authEventView = authEventSchema.omit({ ipHash: true }).extend({
  /** The outbox event that carried it. */
  sourceEventId: z.uuid().nullable(),
});
export type AuthEventView = z.infer<typeof authEventView>;

export const chainHeadView = chainHeadSchema.omit({ headHash: true }).extend({ headHash: hex64 });
export const partitionSealView = partitionSealSchema.omit({ runningHash: true }).extend({ runningHash: hex64 });

export const listAuditEvents = defineContract({
  service: 'audit', name: 'listAuditEvents', method: 'GET', path: '/v1/audit/events', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    from: timestamp.optional(),
    to: timestamp.optional(),
    event: snake.optional(),
    membershipId: z.uuid().optional(),
    /** The scope to read: required unless audit.read is held organisation-wide. */
    scopeId: z.uuid().optional(),
    resourceType: snake.optional(),
    resourceId: z.uuid().optional(),
    cursor: cursor.optional(),
    limit: limit(500, 100),
  }),
  response: z.object({ events: z.array(auditEventView), nextCursor: cursor.nullable() }),
});

/**
 * credential_unwrapped (spec 61.9, 77): every unwrap of a secret, from iam.credential_unwraps,
 * its system of record (design: "audit.audit_events does not duplicate it; the Governance page
 * unions the two"). The credential, reason, calling service and correlation; never a value.
 */
export const UNWRAP_REASONS = [
  'connect', 'query', 'mutation', 'read_back', 'refresh', 'probe', 'rotation', 'change_stream', 'idp', 'mfa_verify', 'sso_assert', 'action_event', 'webhook',
] as const;
export const credentialUnwrapView = z.object({
  id: seq,
  event: z.literal('credential_unwrapped'),
  occurredAt: z.string(),
  credential: z.object({ kind: z.enum(['connection_credential', 'identity_provider', 'mfa_factor']), id: z.uuid() }),
  reason: z.enum(UNWRAP_REASONS),
  callingService: z.string(),
  correlationId: z.string(),
  membershipId: z.uuid().nullable(),
  servicePrincipalId: z.uuid().nullable(),
  keyVersionId: z.uuid().nullable(),
  dekCacheHit: z.boolean(),
  outcome: z.enum(['ok', 'failed', 'held_by_agent']),
});
export type CredentialUnwrapView = z.infer<typeof credentialUnwrapView>;

export const listCredentialUnwraps = defineContract({
  service: 'audit', name: 'listCredentialUnwraps', method: 'GET', path: '/v1/audit/credential-unwraps', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    from: timestamp.optional(),
    to: timestamp.optional(),
    reason: z.enum(UNWRAP_REASONS).optional(),
    /** One credential's unwraps: a connection credential, an identity provider or an MFA factor. */
    credentialId: z.uuid().optional(),
    cursor: cursor.optional(),
    limit: limit(500, 100),
  }),
  response: z.object({ unwraps: z.array(credentialUnwrapView), nextCursor: cursor.nullable() }),
});

export const listAuthEvents = defineContract({
  service: 'audit', name: 'listAuthEvents', method: 'GET', path: '/v1/audit/auth-events', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    from: timestamp.optional(),
    to: timestamp.optional(),
    event: snake.optional(),
    userId: z.uuid().optional(),
    membershipId: z.uuid().optional(),
    cursor: cursor.optional(),
    limit: limit(500, 100),
  }),
  response: z.object({ events: z.array(authEventView), nextCursor: cursor.nullable() }),
});

export const listChainHeads = defineContract({
  service: 'audit', name: 'listChainHeads', method: 'GET', path: '/v1/audit/chain-heads', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ before: z.iso.date().optional(), limit: limit(366, 31) }),
  response: z.object({ heads: z.array(chainHeadView) }),
});

export const readAuditChain = defineContract({
  service: 'audit', name: 'readAuditChain', method: 'GET', path: '/v1/audit/chain', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ afterChainSeq: seq.default('0'), limit: limit(5_000, 1_000) }),
  response: z.object({
    /** The link this run follows; for the first run, the genesis hash of the organisation. */
    anchor: z.object({ chainSeq: seq, rowHash: hex64 }),
    events: z.array(auditEventView),
    verification: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), count: z.number().int().min(0), lastHash: hex64 }),
      z.object({ ok: z.literal(false), chainSeq: seq, reason: z.enum(['organisation', 'gap', 'prev_hash', 'row_hash']) }),
    ]),
  }),
});

export const listPartitionSeals = defineContract({
  service: 'audit', name: 'listPartitionSeals', method: 'GET', path: '/v1/audit/seals', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    ledger: z.enum(['audit.auth_events', 'audit.audit_events', 'platform.model_calls', 'iam.credential_unwraps']).optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
    limit: limit(1_000, 200),
  }),
  response: z.object({ seals: z.array(partitionSealView) }),
});
