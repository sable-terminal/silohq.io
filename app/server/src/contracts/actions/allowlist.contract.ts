// The actuation allow-list (spec 47.4, 47.7, 47.8): the industrial nodes, topics and physical
// webhook actions Silo may write, per connection, each entry added by two distinct people, at
// least one holding actuation.approve, and signed by the control plane once approved, so the
// agent can refuse any write to a node absent from its current signed list whatever the cell
// asks.
//
// - Requested by the connection's owner (industrial.declare_writable at its owning scope),
//   for a live physical writable point of the connection's manifest (20.3, 20.7): the entry's
//   kind (a setpoint, a command, an OPC UA method), data type, range and largest step (a
//   setpoint's), least interval between writes, inverse command (a command's), simulator node
//   (for a dry run, 47.5) and the digital clone object it belongs to; for a method that takes
//   input arguments, each one in the method's order with its bounds (D245): a number's range,
//   the text values allowed, a Boolean either way.
// - Never an interlock, safety function, alarm limit or protection setting (47.4): a node
//   named as one is refused.
// - Decided by another person: approved, the entry is signed and listed (allowlist_entry_added,
//   allowlist_signed); rejected, it is not. Self-approval is never permitted.
// - An entry is never edited: a change is a removal (allowlist_entry_removed) and a new request.

import { z } from 'zod';
import { METHOD_ARGUMENT_TYPES } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

/** What signs an entry: the purpose before the NUL, as an execution grant's. */
export const ALLOWLIST_ENTRY_PREFIX = 'silo.actuation_allowlist.v1';

export const ALLOWLIST_TRANSPORTS = ['mqtt', 'opcua', 'webhook'] as const;
export const ALLOWLIST_KINDS = ['setpoint', 'command', 'method'] as const;

/** A decimal as text (numeric in the database): no float rounding between the cell and the agent. */
const decimal = z.string().regex(/^-?\d{1,18}(\.\d{1,12})?$/, 'a decimal number');

/**
 * An OPC UA method's input argument as its entry bounds it (D245), by the name and built-in type
 * the method declares: a number between its least and greatest value, text among the values
 * listed, a Boolean either way. The agent checks the method's own declaration against these.
 */
export const allowlistArgument = z.strictObject({
  name: z.string().trim().min(1).max(128),
  dataType: z.enum(METHOD_ARGUMENT_TYPES),
  minValue: decimal.optional(),
  maxValue: decimal.optional(),
  values: z.array(z.string().max(256)).min(1).max(50).optional(),
});
export type AllowlistArgument = z.infer<typeof allowlistArgument>;

export const allowlistEntryInput = z.strictObject({
  nodeAddress: z.string().trim().min(1).max(1_300),
  kind: z.enum(ALLOWLIST_KINDS),
  /** The value's type: an OPC UA data type (Double, Int32, Boolean...), or the payload's for MQTT and webhooks. */
  dataType: z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  minValue: decimal.optional(),
  maxValue: decimal.optional(),
  maxStep: decimal.optional(),
  minIntervalSeconds: z.int().min(0).max(86_400),
  inverseCommand: z.string().trim().min(1).max(1_300).optional(),
  simulatorAddress: z.string().trim().min(1).max(1_300).optional(),
  /** A method's input arguments, in the order it declares them; absent for one that takes none. */
  arguments: z.array(allowlistArgument).min(1).max(10).optional(),
  /** The digital clone object the node belongs to. */
  objectId: z.uuid(),
});
export type AllowlistEntryInput = z.infer<typeof allowlistEntryInput>;

export const allowlistEntryView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  transport: z.enum(ALLOWLIST_TRANSPORTS),
  nodeAddress: z.string(),
  kind: z.enum(ALLOWLIST_KINDS),
  dataType: z.string(),
  minValue: z.string().nullable(),
  maxValue: z.string().nullable(),
  maxStep: z.string().nullable(),
  minIntervalSeconds: z.int(),
  inverseCommand: z.string().nullable(),
  simulatorAddress: z.string().nullable(),
  arguments: z.array(z.object({
    name: z.string(), dataType: z.string(), minValue: z.string().nullable(), maxValue: z.string().nullable(), values: z.array(z.string()).nullable(),
  })).nullable(),
  objectId: z.uuid(),
  addedBy: z.uuid(),
  approvedBy: z.uuid(),
  approvedAt: z.string(),
  signatureKeyRef: z.string(),
  createdAt: z.string(),
  removedAt: z.string().nullable(),
});
export type AllowlistEntryView = z.infer<typeof allowlistEntryView>;

export const allowlistRequestView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  transport: z.enum(ALLOWLIST_TRANSPORTS),
  entry: allowlistEntryInput,
  requestedBy: z.uuid(),
  status: z.enum(['pending', 'approved', 'rejected']),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  entryId: z.uuid().nullable(),
  createdAt: z.string(),
});
export type AllowlistRequestView = z.infer<typeof allowlistRequestView>;

const connectionParams = z.strictObject({ connectionId: z.uuid() });

export const requestAllowlistEntry = defineContract({
  service: 'actions', name: 'requestAllowlistEntry', method: 'POST', path: '/v1/connections/:connectionId/actuation-allowlist/requests',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: connectionParams, body: allowlistEntryInput, response: allowlistRequestView, status: 201, maxBodyBytes: 8_192,
});

export const decideAllowlistRequest = defineContract({
  service: 'actions', name: 'decideAllowlistRequest', method: 'POST', path: '/v1/actuation-allowlist/requests/:requestId/decision',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ requestId: z.uuid() }),
  body: z.strictObject({ decision: z.enum(['approve', 'reject']) }),
  response: z.object({ request: allowlistRequestView, entry: allowlistEntryView.nullable() }),
  maxBodyBytes: 256,
});

export const listAllowlist = defineContract({
  service: 'actions', name: 'listAllowlist', method: 'GET', path: '/v1/connections/:connectionId/actuation-allowlist',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: connectionParams,
  response: z.object({ entries: z.array(allowlistEntryView), pending: z.array(allowlistRequestView) }),
});

export const removeAllowlistEntry = defineContract({
  service: 'actions', name: 'removeAllowlistEntry', method: 'POST', path: '/v1/actuation-allowlist/:entryId/removal',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ entryId: z.uuid() }),
  response: allowlistEntryView,
  maxBodyBytes: 256,
});
