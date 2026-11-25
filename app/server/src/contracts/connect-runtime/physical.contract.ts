// The nodes a physical Action would write or command (spec 47.3, 47.4): for a setpoint, each
// record's node at the field's browse path (its address by namespace URI) and its value now, read
// through the connection's Silo Agent; for a command, the method its custom action calls (its
// address, read the same way) or the MQTT topic it publishes to and the payload, checked against
// the declared schema. actions checks them against the signed allow-list and shows them in the
// preview before anything is approved.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const resolvePhysicalTargets = defineContract({
  service: 'connect-runtime', name: 'resolvePhysicalTargets', method: 'POST', path: '/v1/physical-targets',
  callers: ['actions', 'revert'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    object: name,
    /** Setpoints: each record's fields written. */
    targets: z.array(z.strictObject({ identifier: z.string().min(1).max(500), fields: z.array(name).min(1).max(100) })).max(100).default([]),
    /** Commands (47.1): each record's custom action and the inputs it is sent with. */
    commands: z.array(z.strictObject({
      identifier: z.string().min(1).max(500), customAction: name, inputs: z.record(z.string(), z.json()).default({}),
    })).max(100).default([]),
  }).refine((b) => (b.targets.length > 0) !== (b.commands.length > 0), { message: 'setpoints or commands, one of the two', path: ['commands'] }),
  response: z.object({
    nodes: z.array(z.object({
      identifier: z.string(), field: z.string(),
      /** Null where the record or the node is not on the server. */
      nodeAddress: z.string().nullable(),
      current: z.json().nullable(),
    })),
    commands: z.array(z.object({
      identifier: z.string(), customAction: z.string(),
      /** The method's node or the topic; null where the record or the method is not on the server. */
      nodeAddress: z.string().nullable(),
      /** MQTT: the payload as it would be published now. */
      payload: z.string().optional(),
      /** OPC UA: the method's input arguments as it would be called now, in the order it declares them (D245). */
      arguments: z.array(z.object({ name: z.string(), value: z.json() })).optional(),
    })),
  }),
  maxBodyBytes: 256 * 1024,
});
