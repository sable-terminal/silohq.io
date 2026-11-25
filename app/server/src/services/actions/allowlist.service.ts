// The actuation allow-list (spec 47.4, 47.7, 47.8; contracts/actions/allowlist.contract.ts).
//
// - A request names a live physical writable point of the connection's manifest by its
//   address, the connection being an OPC UA or MQTT one (every write physical) or one whose
//   webhooks are declared physical. It is made by the connection's owner
//   (industrial.declare_writable at its owning scope); whether they hold actuation.approve is
//   recorded with it.
// - An interlock, safety function, alarm limit or protection setting is never listed: a node,
//   inverse command or simulator node whose name says it is one is refused (47.4). The
//   customer's control system stays the authority.
// - Another person decides. Approving needs the connection's owner or actuation.approve, and
//   one of the two people must hold actuation.approve; self-approval is never permitted. The
//   approved entry is signed by the control plane (the execution grant key, under its own
//   purpose prefix) over its canonical text, which the agent checks byte for byte.
// - Removal ends an entry; nothing else about one changes (the table's guard).
// - A physical webhook (47.1) is listed by its action's name, as a command (no state value):
//   the name is a live physical outbound target's of the connection, and an inverse command
//   another live target's. It has no simulator counterpart: its Action's record writes are not
//   physical, so it is never dry run.

import { createPublicKey } from 'node:crypto';
import type { AllowlistArgument, AllowlistEntryInput, AllowlistEntryView, AllowlistRequestView } from '../../contracts/actions/allowlist.contract.ts';
import { ALLOWLIST_ENTRY_PREFIX } from '../../contracts/actions/allowlist.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ActuationAllowlist } from '../../models/action/actuationAllowlist.model.ts';
import type { ActuationAllowlistRequest } from '../../models/action/actuationAllowlistRequest.model.ts';
import { actuationAllowlistRepo, actuationAllowlistRequestRepo } from '../../repos/action/index.repo.ts';
import { connectionRepo, connectorManifestRepo, webhookEndpointRepo, writablePointRepo } from '../../repos/connect/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { instructionKeyId, signInstruction } from '../../utils/signedInstruction.util.ts';
import { memberOf, permitted, type Context, type WriteBackDeps } from './deps.service.ts';
import { recordActionEvent } from './events.service.ts';

type Transport = AllowlistEntryView['transport'];

/**
 * The words a node that protects people or plant is named with: never listed (47.4). The
 * node's own name is read (an OPC UA node's identifier, not its namespace; a topic's levels),
 * split into words at case changes and punctuation: HighAlarmLimit, ESD_Valve, Interlock.Bypass
 * and Pump/EStop are refused; Stripper and a namespace urn:acme:limited are not.
 */
const PROTECTIVE = new Set([
  'interlock', 'interlocks', 'safety', 'sis', 'sif', 'esd', 'trip', 'trips', 'alarm', 'alarms', 'protection', 'protective', 'protect',
  'estop', 'emergency', 'shutdown', 'bypass', 'override', 'limit', 'limits',
]);

export function protectiveName(address: string): boolean {
  const name = address.startsWith('nsu=') ? address.slice(address.indexOf(';') + 1) : address;
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // E-stop and shut down as two words; Pressure_Stop is neither.
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return words.some((w) => PROTECTIVE.has(w)) || pairs.some((p) => p === 'e stop' || p === 'shut down');
}

/**
 * The text the control plane signs and the agent checks: canonical JSON of the entry. A method's
 * input arguments (D245) are in it only where it takes some, so an entry without them reads as it
 * always has.
 */
export function allowlistEntryText(e: Pick<ActuationAllowlist, 'id' | 'organisationId' | 'connectionId' | 'transport' | 'nodeAddress' | 'kind'
  | 'dataType' | 'minValue' | 'maxValue' | 'maxStep' | 'minIntervalSeconds' | 'inverseCommand' | 'simulatorAddress' | 'objectId' | 'addedBy'
  | 'approvedBy' | 'approvedAt'> & { arguments?: unknown }): string {
  const args = argumentsOf(e.arguments);
  return canonicalJson({
    v: 1, purpose: 'actuation_allowlist_entry', id: e.id, organisation_id: e.organisationId, connection_id: e.connectionId,
    transport: e.transport, node_address: e.nodeAddress, kind: e.kind, data_type: e.dataType,
    min_value: decimalText(e.minValue), max_value: decimalText(e.maxValue), max_step: decimalText(e.maxStep),
    min_interval_seconds: e.minIntervalSeconds, inverse_command: e.inverseCommand, simulator_address: e.simulatorAddress,
    object_id: e.objectId, added_by: e.addedBy, approved_by: e.approvedBy, approved_at: new Date(e.approvedAt).toISOString(),
    arguments: args === null ? undefined : args.map((a) => ({
      name: a.name, data_type: a.dataType, min_value: decimalText(a.minValue ?? null), max_value: decimalText(a.maxValue ?? null), values: a.values ?? null,
    })),
  });
}

/** An entry's input arguments as stored (jsonb), or null for an entry with none. */
export function argumentsOf(stored: unknown): AllowlistArgument[] | null {
  return Array.isArray(stored) && stored.length > 0 ? stored as AllowlistArgument[] : null;
}

/** A numeric as the database returns it, normalised: no trailing zeros, no plus sign. */
function decimalText(value: string | number | null): string | null {
  if (value === null) return null;
  const text = String(value);
  if (!text.includes('.')) return text.replace(/^(-?)0+(\d)/, '$1$2');
  return text.replace(/0+$/, '').replace(/\.$/, '').replace(/^(-?)0+(\d)/, '$1$2');
}

export const entryView = (e: ActuationAllowlist): AllowlistEntryView => ({
  id: e.id, connectionId: e.connectionId, transport: e.transport as Transport, nodeAddress: e.nodeAddress, kind: e.kind as AllowlistEntryView['kind'],
  dataType: e.dataType, minValue: decimalText(e.minValue), maxValue: decimalText(e.maxValue), maxStep: decimalText(e.maxStep),
  minIntervalSeconds: e.minIntervalSeconds, inverseCommand: e.inverseCommand, simulatorAddress: e.simulatorAddress,
  arguments: argumentsOf(e.arguments)?.map((a) => ({
    name: a.name, dataType: a.dataType, minValue: decimalText(a.minValue ?? null), maxValue: decimalText(a.maxValue ?? null), values: a.values ?? null,
  })) ?? null,
  objectId: e.objectId,
  addedBy: e.addedBy, approvedBy: e.approvedBy, approvedAt: new Date(e.approvedAt).toISOString(), signatureKeyRef: e.signatureKeyRef,
  createdAt: e.createdAt, removedAt: e.removedAt,
});

const requestView = (r: ActuationAllowlistRequest): AllowlistRequestView => ({
  id: r.id, connectionId: r.connectionId, transport: r.transport as Transport, entry: r.entry as AllowlistEntryInput, requestedBy: r.requestedBy,
  status: r.status as AllowlistRequestView['status'], decidedBy: r.decidedBy, decidedAt: r.decidedAt, entryId: r.entryId, createdAt: r.createdAt,
});

/** The connection, the transport its writes take, and the live physical writable point at the address. */
async function writableTarget(db: Queryable, connectionId: string, address: string) {
  const connection = await connectionRepo.findById(db, connectionId);
  if (connection === undefined) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
  if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection writes nothing', { code: 'connection.revoked' });
  const row = await connectorManifestRepo.findById(db, connection.manifestId);
  const manifest = row === undefined ? undefined : manifestSchema.safeParse(row.document);
  if (manifest?.success !== true) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'connection.manifest_unreadable' });
  const kind = manifest.data.protocol.kind;
  const transport: Transport | undefined = kind === 'opc_ua' ? 'opcua' : kind === 'mqtt' ? 'mqtt' : connection.physicalWebhook ? 'webhook' : undefined;
  if (transport === undefined) {
    throw new AppError('validation', 'only an OPC UA or MQTT connection, or one whose webhooks are physical, has an actuation allow-list', {
      code: 'actuation.not_physical_connection',
    });
  }
  const point = (await writablePointRepo.listForConnection(db, connectionId, false))
    .find((p) => p.manifestId === connection.manifestId && p.address === address && p.riskClass === 'physical');
  if (point === undefined) {
    throw new AppError('validation', 'the node is not a declared physical writable point of the connection\'s manifest: declare it first', {
      code: 'actuation.point_not_declared',
    });
  }
  return { connection, transport, point };
}

/** A physical webhook's entry names live outbound targets of the connection: itself (physical) and its inverse. */
async function checkWebhookTargets(db: Queryable, connectionId: string, e: AllowlistEntryInput): Promise<void> {
  const target = await webhookEndpointRepo.liveAction(db, connectionId, e.nodeAddress);
  if (target === undefined || target.riskClass !== 'physical') {
    throw new AppError('validation', 'no live physical webhook target of the connection is named for that action', { code: 'actuation.webhook_target_missing' });
  }
  if (e.inverseCommand !== undefined && await webhookEndpointRepo.liveAction(db, connectionId, e.inverseCommand) === undefined) {
    throw new AppError('validation', 'no live webhook target of the connection is named for the inverse command', { code: 'actuation.webhook_inverse_missing' });
  }
}

function checkEntry(transport: Transport, e: AllowlistEntryInput): void {
  const refuse = (message: string, code: string): never => { throw new AppError('validation', message, { code }); };
  for (const address of [e.nodeAddress, e.inverseCommand, e.simulatorAddress]) {
    if (address !== undefined && protectiveName(address)) {
      refuse('an interlock, safety function, alarm limit or protection setting is never written: the control system stays the authority', 'actuation.protective_node');
    }
  }
  if (e.kind === 'method' && transport !== 'opcua') refuse('a method is an OPC UA call', 'actuation.method_not_opcua');
  if (transport === 'webhook' && e.kind !== 'command') refuse('a webhook has no state value: it is listed as a command', 'actuation.webhook_not_command');
  if (transport === 'webhook' && e.simulatorAddress !== undefined) {
    refuse('a webhook is never dry run: its Action\'s record writes are not physical', 'actuation.webhook_no_simulator');
  }
  if ((e.minValue === undefined) !== (e.maxValue === undefined)) refuse('a range names both its least and its greatest value', 'actuation.range_half');
  if (e.minValue !== undefined && Number(e.minValue) > Number(e.maxValue)) refuse('the least value is above the greatest', 'actuation.range_inverted');
  if (e.kind !== 'setpoint' && (e.minValue !== undefined || e.maxStep !== undefined)) {
    refuse('a range and a step are a setpoint\'s: a command or method has no state value', 'actuation.range_not_setpoint');
  }
  if (e.maxStep !== undefined && Number(e.maxStep) <= 0) refuse('the largest step is above zero', 'actuation.step_not_positive');
  if (e.inverseCommand !== undefined && e.kind === 'setpoint') refuse('a setpoint is reverted by its prior value, not a command', 'actuation.inverse_not_command');
  if (e.simulatorAddress !== undefined && e.simulatorAddress === e.nodeAddress) refuse('the simulator node is not the production node', 'actuation.simulator_is_production');
  // A method's input arguments (D245): each bounded as its type needs, so nothing unbounded reaches the equipment.
  if (e.arguments !== undefined) {
    if (e.kind !== 'method') refuse('input arguments are a method\'s', 'actuation.arguments_not_method');
    const names = new Set<string>();
    for (const a of e.arguments) {
      if (names.has(a.name)) refuse(`the argument ${a.name} is named twice`, 'actuation.argument_repeated');
      names.add(a.name);
      const numeric = a.dataType !== 'Boolean' && a.dataType !== 'String';
      if (numeric && (a.minValue === undefined || a.maxValue === undefined)) {
        refuse(`the argument ${a.name} is a number: its entry gives the least and the greatest value it may take`, 'actuation.argument_range');
      }
      if (numeric && Number(a.minValue) > Number(a.maxValue)) refuse(`the least value of ${a.name} is above its greatest`, 'actuation.range_inverted');
      if (!numeric && (a.minValue !== undefined || a.maxValue !== undefined)) refuse(`a range is a number's, and ${a.name} is a ${a.dataType}`, 'actuation.argument_range');
      if (a.dataType === 'String' && a.values === undefined) {
        refuse(`the argument ${a.name} is text: its entry lists the values it may take`, 'actuation.argument_values');
      }
      if (a.dataType !== 'String' && a.values !== undefined) refuse(`values to choose from are text's, and ${a.name} is a ${a.dataType}`, 'actuation.argument_values');
    }
  }
}

export function createAllowlist(deps: WriteBackDeps & { signingKey?: import('node:crypto').KeyObject | undefined }) {
  const control = deps.databases.pool('control');

  return {
    async request(ctx: Context, connectionId: string, input: AllowlistEntryInput): Promise<AllowlistRequestView> {
      const { organisationId, membershipId } = memberOf(ctx, 'asking for an allow-list entry');
      const { connection, transport } = await inTransaction(control, ctx.request, (db) => writableTarget(db, connectionId, input.nodeAddress), { readOnly: true });
      if (!await permitted(deps, ctx, 'industrial.declare_writable', connection.owningScopeId)) {
        throw new AppError('forbidden', 'the connection\'s owner asks for its allow-list entries (industrial.declare_writable)', { code: 'actuation.not_owner' });
      }
      checkEntry(transport, input);
      const holds = await permitted(deps, ctx, 'actuation.approve');
      return inTransaction(control, ctx.request, async (db) => {
        if (transport === 'webhook') await checkWebhookTargets(db, connectionId, input);
        if (await actuationAllowlistRepo.liveFor(db, connectionId, transport, input.nodeAddress) !== undefined) {
          throw new AppError('conflict', 'the node is listed already: remove its entry first to change it', { code: 'actuation.entry_exists' });
        }
        const row = await actuationAllowlistRequestRepo.insert(db, {
          id: uuidv7(), organisationId, connectionId, transport, entry: JSON.parse(JSON.stringify(input)) as Record<string, string | number>, requestedBy: membershipId,
          requesterHoldsActuation: holds,
        });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'allowlist_entry_requested', request: ctx.request, service: 'actions',
          resource: { type: 'connection', id: connectionId }, detail: { request_id: row.id, transport, kind: input.kind },
        });
        return requestView(row);
      });
    },

    async decide(ctx: Context, requestId: string, decision: 'approve' | 'reject'): Promise<{ request: AllowlistRequestView; entry: AllowlistEntryView | null }> {
      const { organisationId, membershipId } = memberOf(ctx, 'deciding an allow-list entry');
      const pending = await inTransaction(control, ctx.request, (db) => actuationAllowlistRequestRepo.findById(db, requestId), { readOnly: true });
      if (pending === undefined) throw new AppError('not_found', 'no such allow-list request', { code: 'actuation.request_not_found' });
      if (pending.status !== 'pending') throw new AppError('conflict', 'that request is decided already', { code: 'actuation.request_decided' });
      if (pending.requestedBy === membershipId) {
        throw new AppError('forbidden', 'another person decides an allow-list entry: self-approval is never permitted', { code: 'actuation.self_approval' });
      }
      const entry = pending.entry as AllowlistEntryInput;
      const { connection, transport } = await inTransaction(control, ctx.request, (db) => writableTarget(db, pending.connectionId, entry.nodeAddress), { readOnly: true });
      const holds = await permitted(deps, ctx, 'actuation.approve');
      if (!holds && !await permitted(deps, ctx, 'industrial.declare_writable', connection.owningScopeId)) {
        throw new AppError('forbidden', 'the connection\'s owner or a holder of actuation.approve decides its allow-list entries', { code: 'actuation.not_decider' });
      }
      if (decision === 'approve' && !holds && !pending.requesterHoldsActuation) {
        throw new AppError('forbidden', 'one of the two people adding an entry holds actuation.approve (the physical operations role)', {
          code: 'actuation.approver_required',
        });
      }
      if (decision === 'approve' && deps.signingKey === undefined) {
        throw new AppError('configuration', 'this cell has no control plane signing key: allow-list entries cannot be signed', { code: 'actuation.signing_unavailable' });
      }
      const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions' as const };
      try {
        return await inTransaction(control, ctx.request, async (db) => {
          const decidedAt = new Date().toISOString();
          if (decision === 'reject') {
            const row = await actuationAllowlistRequestRepo.decide(db, requestId, { status: 'rejected', decidedBy: membershipId, decidedAt, entryId: null });
            if (row === undefined) throw new AppError('conflict', 'that request is decided already', { code: 'actuation.request_decided' });
            await recordActionEvent(db, {
              ...event, event: 'allowlist_entry_rejected', resource: { type: 'connection', id: pending.connectionId },
              detail: { request_id: requestId, requested_by: pending.requestedBy },
            });
            return { request: requestView(row), entry: null };
          }
          // The target may have gone since it was asked for.
          if (transport === 'webhook') await checkWebhookTargets(db, pending.connectionId, entry);
          const id = uuidv7();
          const draft = {
            id, organisationId, connectionId: pending.connectionId, transport, nodeAddress: entry.nodeAddress, kind: entry.kind, dataType: entry.dataType,
            minValue: entry.minValue ?? null, maxValue: entry.maxValue ?? null, maxStep: entry.maxStep ?? null, minIntervalSeconds: entry.minIntervalSeconds,
            inverseCommand: entry.inverseCommand ?? null, simulatorAddress: entry.simulatorAddress ?? null, arguments: entry.arguments === undefined ? null : JSON.parse(JSON.stringify(entry.arguments)) as never,
            objectId: entry.objectId, addedBy: pending.requestedBy, approvedBy: membershipId, approvedAt: decidedAt,
          };
          const key = deps.signingKey!;
          const keyRef = instructionKeyId(createPublicKey(key));
          const signature = Buffer.from(signInstruction(ALLOWLIST_ENTRY_PREFIX, allowlistEntryText(draft), key), 'base64url');
          const inserted = await actuationAllowlistRepo.insert(db, { ...draft, signature, signatureKeyRef: keyRef });
          const row = await actuationAllowlistRequestRepo.decide(db, requestId, { status: 'approved', decidedBy: membershipId, decidedAt, entryId: id });
          if (row === undefined) throw new AppError('conflict', 'that request is decided already', { code: 'actuation.request_decided' });
          const resource = { type: 'allowlist_entry' as const, id };
          await recordActionEvent(db, {
            ...event, event: 'allowlist_entry_added', resource,
            detail: { connection_id: pending.connectionId, transport, kind: entry.kind, added_by: pending.requestedBy, approved_by: membershipId, request_id: requestId },
          });
          await recordActionEvent(db, { ...event, event: 'allowlist_signed', resource, detail: { connection_id: pending.connectionId, key_ref: keyRef } });
          return { request: requestView(row), entry: entryView(inserted) };
        });
      } catch (error) {
        if (fromDatabaseError(error).category === 'conflict') {
          throw new AppError('conflict', 'the node is listed already: remove its entry first to change it', { code: 'actuation.entry_exists' });
        }
        throw error;
      }
    },

    async list(ctx: Context, connectionId: string): Promise<{ entries: AllowlistEntryView[]; pending: AllowlistRequestView[] }> {
      memberOf(ctx, 'reading an allow-list');
      const connection = await inTransaction(control, ctx.request, (db) => connectionRepo.findById(db, connectionId), { readOnly: true });
      if (connection === undefined) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
      if (!await permitted(deps, ctx, 'actuation.approve') && !await permitted(deps, ctx, 'industrial.declare_writable', connection.owningScopeId)) {
        throw new AppError('forbidden', 'the connection\'s owner or a holder of actuation.approve reads its allow-list', { code: 'actuation.not_decider' });
      }
      return inTransaction(control, ctx.request, async (db) => ({
        entries: (await actuationAllowlistRepo.liveForConnection(db, connectionId)).map(entryView),
        pending: (await actuationAllowlistRequestRepo.pendingForConnection(db, connectionId)).map(requestView),
      }), { readOnly: true });
    },

    async remove(ctx: Context, entryId: string): Promise<AllowlistEntryView> {
      const { organisationId } = memberOf(ctx, 'removing an allow-list entry');
      const entry = await inTransaction(control, ctx.request, (db) => actuationAllowlistRepo.findById(db, entryId), { readOnly: true });
      if (entry === undefined) throw new AppError('not_found', 'no such allow-list entry', { code: 'actuation.entry_not_found' });
      const connection = await inTransaction(control, ctx.request, (db) => connectionRepo.findById(db, entry.connectionId), { readOnly: true });
      // Removing only takes a capability away: either the owner or a holder of actuation.approve may.
      if (!await permitted(deps, ctx, 'actuation.approve') && !await permitted(deps, ctx, 'industrial.declare_writable', connection?.owningScopeId)) {
        throw new AppError('forbidden', 'the connection\'s owner or a holder of actuation.approve removes its allow-list entries', { code: 'actuation.not_decider' });
      }
      return inTransaction(control, ctx.request, async (db) => {
        const removed = await actuationAllowlistRepo.remove(db, entryId);
        if (removed === undefined) throw new AppError('conflict', 'that entry is removed already', { code: 'actuation.entry_removed' });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'allowlist_entry_removed', request: ctx.request, service: 'actions',
          resource: { type: 'allowlist_entry', id: entryId }, detail: { connection_id: entry.connectionId, transport: entry.transport },
        });
        return entryView(removed);
      });
    },
  };
}

export type Allowlist = ReturnType<typeof createAllowlist>;
