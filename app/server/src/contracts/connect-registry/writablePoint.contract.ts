// Writable points (spec 20.3, 20.5, 20.7): the nodes, topics or webhook actions a connection
// may write, each declared by a connection owner holding industrial.declare_writable, against
// the manifest version it runs. A point declares its value check (CEL over values and prior,
// required: a point without one cannot be written), the node read back for verification and
// how long to wait for it to settle, and whether the owner nominates it as safe for
// conformance writes. Its risk class is at least its transport's default (MQTT and OPC UA are
// physical) and can be raised, never lowered. A point is retired, never deleted.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const writablePointView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  manifestId: z.uuid(),
  address: z.string(),
  riskClass: z.enum(['standard', 'physical']),
  valueCheck: z.string(),
  feedbackAddress: z.string().nullable(),
  settleSeconds: z.int(),
  testSafe: z.boolean(),
  declaredBy: z.uuid(),
  declaredAt: z.string(),
  retiredAt: z.string().nullable(),
});
export type WritablePointView = z.infer<typeof writablePointView>;

const connectionId = z.strictObject({ connectionId: z.uuid() });
const pointId = z.strictObject({ pointId: z.uuid() });
/** An OPC UA node by namespace URI and identifier (never a namespace index), an MQTT topic (no wildcards), or a webhook action's name. */
const address = z.string().trim().min(1).max(1_024);

export const declareWritablePoint = defineContract({
  service: 'connect-registry', name: 'declareWritablePoint', method: 'POST', path: '/v1/connections/:connectionId/writable-points',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    address,
    /** Absent: the transport's default (physical for MQTT and OPC UA, standard otherwise). Never below it. */
    riskClass: z.enum(['standard', 'physical']).optional(),
    /** CEL over values (what is written) and prior (the point's value before), true to allow: range, step, unit. */
    valueCheck: z.strictObject({ cel: z.string().trim().min(1).max(2_000) }),
    /** The node read back to verify the write; the point itself when absent. */
    feedbackAddress: address.optional(),
    settleSeconds: z.int().min(0).max(3_600).default(0),
    /** The owner nominates the point as safe for conformance writes (20.5): physical connectors write only there. */
    testSafe: z.boolean().default(false),
  }),
  response: writablePointView,
  status: 201,
  maxBodyBytes: 8 * 1024,
});

export const listWritablePoints = defineContract({
  service: 'connect-registry', name: 'listWritablePoints', method: 'GET', path: '/v1/connections/:connectionId/writable-points',
  callers: ['gateway', 'actions'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  query: z.strictObject({ includeRetired: z.enum(['true', 'false']).optional() }),
  response: z.object({ points: z.array(writablePointView) }),
});

/** Raise a point to physical (writable_point_risk_raised); a lower class is refused. */
export const raiseWritablePointRisk = defineContract({
  service: 'connect-registry', name: 'raiseWritablePointRisk', method: 'POST', path: '/v1/writable-points/:pointId/risk',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: pointId,
  body: z.strictObject({ riskClass: z.literal('physical') }),
  response: writablePointView,
  maxBodyBytes: 1_024,
});

/** Nominate the point as safe for conformance writes, or withdraw it. */
export const setWritablePointTestSafe = defineContract({
  service: 'connect-registry', name: 'setWritablePointTestSafe', method: 'POST', path: '/v1/writable-points/:pointId/test-safe',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: pointId,
  body: z.strictObject({ testSafe: z.boolean() }),
  response: writablePointView,
  maxBodyBytes: 1_024,
});

export const retireWritablePoint = defineContract({
  service: 'connect-registry', name: 'retireWritablePoint', method: 'POST', path: '/v1/writable-points/:pointId/retire',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: pointId,
  response: writablePointView,
  maxBodyBytes: 1_024,
});
