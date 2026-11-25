// The write-verify-undo class (spec 17.1, 43.4 check 5): a connector earns writes by passing
// a sandboxed write, verify and undo cycle on the connection, before writes are enabled.
//
// The cycle runs through connect-runtime's write path in the sandbox (the conformance
// service alone may write before writes are enabled):
// - an object that declares create and delete: a test record is created from the sample
//   values, read back and compared; updated with the sample update and verified, where the
//   object declares update; then deleted, and its absence verified (the undo);
// - an object that declares update only: the named record's sampled fields are read, updated,
//   verified, and restored to what they were, and the restoration verified (the undo).
// The sample values are the requester's: no engine can invent values a source will accept.
// The run is recorded in connect.conformance_runs with class write_verify_undo; results hold
// test ids, outcomes and reason codes, never values.
//
// Enabling writes (connection.writes_enabled) is connector.enable_writes, an authorising
// permission, at the connection's owning scope, and needs a passed write class run on the
// connection's current manifest version. Disabling needs the same permission and no run.
//
// The write class status says whether that run exists and passed: what the AI FDE proposes
// write enablement from (spec 51.7). It carries the run's counts, never its values.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { conformanceTest } from './conformance.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const values = z.record(name, z.json());
const connectionId = z.strictObject({ connectionId: z.uuid() });

export const runWriteClass = defineContract({
  service: 'conformance', name: 'runWriteClass', method: 'POST', path: '/v1/connections/:connectionId/write-class', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    object: name,
    /** Values for the test record (create and delete), or the record to change and restore (update only). */
    create: values.optional(),
    identifier: z.string().min(1).max(500).optional(),
    /** Fields to change, to exercise the update and its verification. */
    update: values.optional(),
  }).refine((b) => b.create !== undefined || (b.identifier !== undefined && b.update !== undefined),
    'give values for a test record, or a record and the update to make and undo'),
  response: z.object({
    runId: z.uuid(),
    passed: z.boolean(),
    tests: z.array(conformanceTest),
  }),
  maxBodyBytes: 64 * 1024,
});

export const getWriteClassStatus = defineContract({
  service: 'conformance', name: 'getWriteClassStatus', method: 'GET', path: '/v1/connections/:connectionId/write-class', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  response: z.object({
    connectionId: z.uuid(),
    manifestId: z.uuid(),
    writesEnabled: z.boolean(),
    /** The latest completed write class run on the current manifest version; null when none ran. */
    run: z.object({ id: z.uuid(), passed: z.boolean(), passedCount: z.int(), failedCount: z.int(), completedAt: z.string() }).nullable(),
  }),
});
export type WriteClassStatus = z.infer<typeof getWriteClassStatus.response>;

export const setConnectionWrites = defineContract({
  service: 'conformance', name: 'setConnectionWrites', method: 'PUT', path: '/v1/connections/:connectionId/writes', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({ enabled: z.boolean() }),
  response: z.object({ connectionId: z.uuid(), writesEnabled: z.boolean(), runId: z.uuid().nullable() }),
});
