// Signed execution grants (spec 5.6: "approval → signed execution grant → execution"; 10.4:
// "Write-back: only on a signed execution grant from actions naming Action, connection, target
// and payload hash, verified locally. Unsigned or mismatched writes are refused").
//
// actions signs one grant per connection's plan, as it executes an approved Action: Ed25519
// over a fixed prefix and the grant's JSON text, which travels as that text, so whoever checks
// it checks exactly the bytes signed, with no canonical form to agree on. The payload hash is
// SHA-256 of the statements exactly as the agent receives them (their JSON, as connect-runtime
// sends it), which connect-runtime computes before the grant is signed (prepareWrites) and
// again as it sends. A grant lives five minutes and runs once. connect-runtime checks it before
// the write leaves the cell; the agent checks it again with the key it pinned at enrolment.
//
// The write class of conformance (spec 17.1) writes to a connection being verified, before
// writes are enabled: actions signs those too, naming the conformance run, for conformance alone.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const EXECUTION_GRANT_PREFIX = 'silo.execution_grant.v1';
export const GRANT_LIFETIME_SECONDS = 300;

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });

/** What a grant says, as its JSON text is parsed. */
export const executionGrant = z.strictObject({
  version: z.literal(1),
  grantId: z.uuid(),
  organisationId: z.uuid(),
  /** The Action carried out: a mutation, or a conformance run's write class. */
  actionId: z.uuid(),
  actionKind: z.enum(['mutation', 'conformance_write_class']),
  connectionId: z.uuid(),
  /** The target: the source object, and how many statements the plan runs on it. */
  object: name,
  statements: z.int().min(1).max(1_000),
  /** SHA-256, hex, of the statements' JSON exactly as the agent receives it. */
  payloadSha256: sha256Hex,
  issuedAt: timestamp,
  expiresAt: timestamp,
});
export type ExecutionGrant = z.infer<typeof executionGrant>;

/** A grant as it travels: its JSON text as signed, the signing key's id and the signature. */
export const signedExecutionGrant = z.strictObject({
  grant: z.string().min(2).max(4_096),
  /** base64url SHA-256 of the signing key's SubjectPublicKeyInfo. */
  keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type SignedExecutionGrant = z.infer<typeof signedExecutionGrant>;

/** Why a grant was refused: no grant, a signature or key that does not hold, or a grant for something else. */
export const GRANT_REFUSALS = ['unsigned', 'key_unknown', 'signature', 'expired', 'organisation', 'connection', 'object', 'statements', 'payload', 'replayed'] as const;
export type GrantRefusal = (typeof GRANT_REFUSALS)[number];

export const signSandboxWriteGrant = defineContract({
  service: 'actions', name: 'signSandboxWriteGrant', method: 'POST', path: '/v1/execution-grants/sandbox',
  // Not keyed: each grant is single use; a retry asks for another.
  callers: ['conformance'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    /** The conformance run whose write class this is: the Action the grant names. */
    runId: z.uuid(),
    object: name,
    statements: z.int().min(1).max(1_000),
    payloadSha256: sha256Hex,
  }),
  response: signedExecutionGrant,
  maxBodyBytes: 2_048,
});

/**
 * One attempt of an outbound webhook delivery through the Silo Agent (spec 20.4, 10.4): notify
 * asks, with the hash of the request as the agent will receive it; actions signs a grant
 * naming the delivery's mutation, the target's connection, object "webhook" and one statement,
 * only for a delivery still pending on a live target reached through an agent.
 */
export const signWebhookGrant = defineContract({
  service: 'actions', name: 'signWebhookGrant', method: 'POST', path: '/v1/execution-grants/webhook-deliveries/:deliveryId',
  // Not keyed: each grant is single use; a retry asks for another.
  callers: ['notify'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ deliveryId: z.uuid() }),
  body: z.strictObject({ payloadSha256: sha256Hex }),
  response: signedExecutionGrant,
  maxBodyBytes: 256,
});
