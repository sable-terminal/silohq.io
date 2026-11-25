// connect-runtime's write path (spec 45.2, 45.3): the source calls of an approved mutation,
// through the generic engine, and the record reads the mutation path needs around them
// (prior state before, verification after, the three-way comparison of a revert).
//
// writeRecords runs one connection's plan for one source object, in plan order:
// - the connection must be active and have earned writes (writes_enabled, spec 17.1), the
//   object must declare each operation, and the plan must fit the manifest's write bound;
//   the manifest's value check (CEL over values and prior) refuses a write before it is sent;
// - SQL runs the plan in one transaction of the source (it commits or rolls back as a unit);
//   REST reports each operation on its own (45.2: not atomic, and the result says so);
// - rate-limited and failing sources are retried for updates and deletes; a create is never
//   retried blindly (45.3); an auth failure stops the plan.
// The conformance service's write class runs the same path on a connection being verified,
// before writes are enabled (sandbox), and only there.
//
// Bodies and results carry record values: never logged.

import { z } from 'zod';
import { signedExecutionGrant } from '../actions/grant.contract.ts';
import { ERROR_MEANINGS } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const values = z.record(name, z.json());

/**
 * The source operations (spec 42.5). update_full sends the whole record, every field but the
 * identifier, since the source replaces it; upsert creates or updates the record its identifier
 * names (MERGE on SQL, 48.1); custom is a custom action endpoint the manifest declares, with its
 * inputs as the values.
 */
export const WRITE_OPERATIONS = ['create', 'update_full', 'update_partial', 'delete', 'upsert', 'custom'] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

export const writeOperation = z.strictObject({
  /** The mutation target's idempotency key: recorded, and the key each result answers to. */
  key: z.string().min(1).max(200),
  operation: z.enum(WRITE_OPERATIONS),
  /** The record's identifier; for a create, absent unless the source takes one. */
  identifier: z.string().min(1).max(500).optional(),
  /** Field name to new value. Empty for a delete. */
  values: values.default({}),
  /** Prior values of the touched fields, for the manifest's value check. */
  prior: values.nullable().default(null),
  /** A custom operation: the custom action's name. */
  customAction: name.optional(),
}).superRefine((o, ctx) => {
  if (o.operation !== 'create' && o.identifier === undefined) ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'an update, upsert, delete or custom action names its record' });
  if ((o.operation === 'custom') !== (o.customAction !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['customAction'], message: 'a custom operation, and only a custom operation, names its custom action' });
  }
});
export type WriteOperationInput = z.input<typeof writeOperation>;

export const writeResult = z.object({
  key: z.string(),
  outcome: z.enum(['applied', 'failed', 'not_attempted']),
  /** The record's identifier; for a create, the one the source assigned or was given. */
  identifier: z.string().nullable(),
  error: z.object({ meaning: z.enum([...ERROR_MEANINGS, 'value_check', 'row_count']), code: z.string() }).nullable(),
  /** A physical write (47.4): each node written, its allow-list entry and what the server said; why the agent refused, if it did. */
  physical: z.object({
    nodes: z.array(z.object({
      path: z.string(), nodeAddress: z.string(), entryId: z.string(), status: z.string(),
      /** A dry run's (47.5): the simulator node written instead, the field it stands for, and what it read back. */
      simulatorAddress: z.string().optional(), field: z.string().optional(), observed: z.json().optional(),
    })).max(500),
    reason: z.string().max(40).optional(),
  }).optional(),
});
export type WriteResult = z.infer<typeof writeResult>;

export const writeRecords = defineContract({
  service: 'connect-runtime', name: 'writeRecords', method: 'POST', path: '/v1/writes',
  callers: ['actions', 'conformance'],
  // Each operation carries the mutation's own key; the plan is not repeated by the runtime.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    object: name,
    operations: z.array(writeOperation).min(1).max(1_000),
    /** A physical Action's dry run (47.5): the simulator nodes, never production. */
    dryRun: z.literal(true).optional(),
    /** The plan's moment: an MQTT command's payload is computed at it, so the statements its grant covers are the ones published. */
    at: z.iso.datetime({ offset: true }).optional(),
    /** Conformance's write class only: a connection being verified, before writes are enabled. */
    sandbox: z.literal(true).optional(),
    /** A write through the Silo Agent: the execution grant actions signed for exactly these statements (spec 10.4). */
    grant: signedExecutionGrant.optional(),
  }),
  response: z.object({
    results: z.array(writeResult),
    /** True when the source applied the plan as one transaction (SQL). */
    transactional: z.boolean(),
    connectorVersion: z.string(),
  }),
  maxBodyBytes: 4 * 1024 * 1024,
});

export const readRecords = defineContract({
  service: 'connect-runtime', name: 'readRecords', method: 'POST', path: '/v1/records',
  callers: ['actions', 'revert', 'conformance'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    object: name,
    identifiers: z.array(z.string().min(1).max(500)).min(1).max(1_000),
    /** The fields to return; the identifier is always returned. */
    fields: z.array(name).min(1).max(2_000),
    /** mutation: prior state and the stale re-read; read_back: verification and revert. */
    reason: z.enum(['mutation', 'read_back']),
    sandbox: z.literal(true).optional(),
  }),
  response: z.object({
    /** One per identifier asked for, in order; values null when the source has no such record. */
    records: z.array(z.object({ identifier: z.string(), values: values.nullable() })),
    connectorVersion: z.string(),
  }),
  maxBodyBytes: 256 * 1024,
});

/**
 * What a write would send, for the grant that must cover it (spec 10.4): the same checks as
 * writeRecords, then, for a write through the Silo Agent, how many statements and the SHA-256
 * of their JSON exactly as they will be sent. Nothing is sent.
 */
export const prepareWrites = defineContract({
  service: 'connect-runtime', name: 'prepareWrites', method: 'POST', path: '/v1/writes/preparations',
  callers: ['actions', 'conformance'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    object: name,
    operations: z.array(writeOperation).min(1).max(1_000),
    /** A physical Action's dry run (47.5): the simulator nodes, never production. */
    dryRun: z.literal(true).optional(),
    /** The plan's moment: an MQTT command's payload is computed at it, so the statements its grant covers are the ones published. */
    at: z.iso.datetime({ offset: true }).optional(),
    sandbox: z.literal(true).optional(),
  }),
  response: z.object({
    grantRequired: z.boolean(),
    statements: z.int().min(1).max(1_000).optional(),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  maxBodyBytes: 4 * 1024 * 1024,
});
