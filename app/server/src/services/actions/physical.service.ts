// Physical Actions in actions (spec 47.1 to 47.6, 47.8).
//
// At intent, for each OPC UA connection a physical Action writes setpoints through: the agent
// resolves every record's node for each field written and reads its value now; then each node
// must be in the connection's signed actuation allow-list as a setpoint, its writable point's
// value check must pass over the value proposed and the value now, the value must be within the
// entry's range and its step from now no larger than the entry's. A command (47.1: an OPC UA
// method call, an MQTT publish) is resolved to the method's node or the topic, with the payload
// checked against its schema; it must be listed as a method (OPC UA) or a command (MQTT), and its
// writable point's value check must pass over the inputs. A revert's command must be the inverse
// the original's entry names (47.6). Either way, the entry's last write must be at least its
// interval ago and the plan within the connection's physical writes a minute (refused, and
// physical_rate_limit_refused: the canary does not apply, beyond the limit is refused). A
// physical webhook (47.1) is a command too: its target's action listed as one, its writable
// point's value check over the Action's parameters; it is never dry run (its Action's record
// writes are not physical, so a dry run sends no webhook), and it is checked again when it is
// queued and before each attempt to send it, by notify and, through the agent, by the agent. The
// preview shows each node or topic, its value now and proposed (a command, its inputs), its
// range, step, interval and the last write, and the statement configuration cannot remove or
// reword; a command that cannot be reverted says so instead.
//
// At execution, every node a write named is logged with what became of it (never a value: the
// receipt holds those); a node the agent refused although the cell passed it is
// physical_write_refused_by_agent, which must never happen in normal operation and raises an
// alert; a node the control system refused is physical_write_rejected_by_control_system, the
// outcome, never retried. With the receipt, physical_action_executed names both approvers,
// the nodes' allow-list entries and the receipt. A command is verified by acknowledgement, and
// its receipt says that acknowledgement does not confirm the physical outcome (47.6).

import type { Preview } from '../../contracts/actions/mutation.contract.ts';
import { resolvePhysicalTargets } from '../../contracts/connect-runtime/physical.contract.ts';
import type { WriteResult } from '../../contracts/connect-runtime/write.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { actuationAllowlistRepo, physicalWriteRepo } from '../../repos/action/index.repo.ts';
import { connectionRepo, webhookEndpointRepo, writablePointRepo } from '../../repos/connect/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { AllowlistArgument } from '../../contracts/actions/allowlist.contract.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import { argumentsOf } from './allowlist.service.ts';
import { callOptions, type ConnectionWithManifest, type Context, type WriteBackDeps } from './deps.service.ts';
import { recordActionEvent } from './events.service.ts';
import type { PlannedTarget } from './store.service.ts';

/** The statement a physical Action's preview shows (47.3): configuration cannot remove or reword it. */
export const PHYSICAL_STATEMENT = 'This Action changes physical equipment. Any physical effect between execution and revert cannot be undone. Revert restores the state value only.';

/** The statement a not_revertible command's preview shows instead (47.3). */
export const NOT_REVERTIBLE_STATEMENT = 'This Action sends a command to physical equipment. It cannot be reverted.';

/** What a command's receipt says of its verification (47.6). */
export const COMMAND_ACKNOWLEDGEMENT = 'A command is verified by acknowledgement. Acknowledgement does not confirm the physical outcome.';

export interface PhysicalNode {
  connectionId: string;
  reference: string;
  /** A setpoint's field; a command's custom action. */
  field: string;
  /** A command (47.1): its custom action; null for a setpoint. */
  command: string | null;
  /** An MQTT command's payload as it would be published. */
  payload: string | null;
  /** A physical webhook's target (its action's name is the node address and the command). */
  endpointId: string | null;
  nodeAddress: string;
  /** A dry run's: the simulator counterpart written instead (47.5). */
  simulatorAddress: string | null;
  entryId: string;
  current: unknown;
  proposed: unknown;
  range: { min: string; max: string } | null;
  maxStep: string | null;
  minIntervalSeconds: number;
  maxPerMinute: number | null;
  lastWrittenAt: string | null;
}

export type PhysicalPlan = { nodes: PhysicalNode[] } | { refused: { stage: 'policy_gate' | 'intent' | 'plan'; reason: string } };

const numeric = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * A method call's input arguments against its signed entry (47.4, D245): the arguments the entry
 * names, in its order, and each value within its bounds (a number's range, the text values
 * listed). The agent checks the same, and the method's own declaration too.
 */
export function argumentsRefused(listed: readonly AllowlistArgument[] | null, called: readonly { name: string; value: unknown }[])
  : { stage: 'policy_gate' | 'intent'; message: string } | undefined {
  const names = (listed ?? []).map((a) => a.name);
  if (names.join('\n') !== called.map((a) => a.name).join('\n')) {
    return { stage: 'policy_gate', message: `the method's input arguments (${called.map((a) => a.name).join(', ') || 'none'}) are not the ones its allow-list entry names (${names.join(', ') || 'none'})` };
  }
  for (const [i, a] of (listed ?? []).entries()) {
    const value = called[i]!.value;
    if (a.dataType === 'String' && !(a.values ?? []).includes(value as string)) {
      return { stage: 'intent', message: `the argument ${a.name} is not one of the values its allow-list entry allows` };
    }
    if (a.minValue !== undefined && (typeof value !== 'number' || value < Number(a.minValue) || value > Number(a.maxValue))) {
      return { stage: 'intent', message: `the argument ${a.name} is outside the range its allow-list entry allows (${a.minValue} to ${a.maxValue})` };
    }
  }
  return undefined;
}

/** The intent checks and the preview's nodes for the physical connections a plan writes through. */
export async function physicalPlan(deps: WriteBackDeps, ctx: Context, input: {
  organisationId: string; targets: readonly PlannedTarget[]; connections: ReadonlyMap<string, ConnectionWithManifest>; actionTypeVersionId: string;
  /** A dry run (47.5): each entry must name its simulator node; production's interval and rate do not apply. */
  dryRun?: boolean | undefined;
  /** A revert's (47.6): the inverse commands the original's entries name; each command must be one. */
  inverses?: ReadonlySet<string> | undefined;
  /** The physical webhook targets the Action posts to (47.1), and the parameters their points' value checks read. */
  webhooks?: readonly string[] | undefined;
  parameters?: Record<string, unknown> | undefined;
}): Promise<PhysicalPlan> {
  const nodes: PhysicalNode[] = [];
  const control = deps.databases.pool('control');
  const refused = (stage: 'policy_gate' | 'intent' | 'plan', reason: string): PhysicalPlan => ({ refused: { stage, reason } });
  for (const [connectionId, found] of input.connections) {
    const kind = found.manifest.protocol.kind;
    if (kind !== 'opc_ua' && kind !== 'mqtt') continue;
    const targets = input.targets.filter((t) => t.connectionId === connectionId && t.operation === 'update_partial' && t.fields.length > 0);
    const commands = input.targets.filter((t) => t.connectionId === connectionId && t.operation === 'custom');
    if (targets.length === 0 && commands.length === 0) continue;
    const object = (targets[0] ?? commands[0]!).sourceObject;
    let resolved;
    try {
      resolved = await deps.services.call(resolvePhysicalTargets, {
        body: targets.length > 0
          ? { connectionId, object, targets: targets.map((t) => ({ identifier: t.entityReference, fields: t.fields })) }
          : { connectionId, object, commands: commands.map((t) => ({ identifier: t.entityReference, customAction: t.customAction!, inputs: t.newValues as never })) },
      }, callOptions(ctx));
    } catch (error) {
      // A command the manifest cannot send as asked (its payload's schema, its topic, its inputs) is refused at intent.
      if (isAppError(error) && error.category === 'validation') return refused('intent', error.message);
      throw error;
    }
    const transport = kind === 'mqtt' ? 'mqtt' : 'opcua';
    const checked = await inTransaction(control, ctx.request, async (db): Promise<PhysicalPlan> => {
      const points = await writablePointRepo.listForConnection(db, connectionId, false);
      const out: PhysicalNode[] = [];
      // Commands (47.1): a method or a command topic, listed as one; no range or step, the point's check over the inputs.
      for (const command of resolved.commands) {
        const target = commands.find((t) => t.entityReference === command.identifier && t.customAction === command.customAction)!;
        const where = `${command.customAction} on ${command.identifier}`;
        if (command.nodeAddress === null) return refused('policy_gate', `the method for ${where} is not on the server`);
        const entry = await actuationAllowlistRepo.liveFor(db, connectionId, transport, command.nodeAddress);
        if (entry === undefined) return refused('policy_gate', `the ${transport === 'mqtt' ? 'topic' : 'method'} for ${where} is not in the connection's actuation allow-list`);
        const wanted = transport === 'mqtt' ? 'command' : 'method';
        if (entry.kind !== wanted) return refused('policy_gate', `the ${transport === 'mqtt' ? 'topic' : 'node'} for ${where} is listed as a ${entry.kind}, not a ${wanted}`);
        if (input.dryRun === true && entry.simulatorAddress === null) {
          return refused('policy_gate', `the entry for ${where} names no simulator counterpart: it cannot be dry run`);
        }
        if (input.inverses !== undefined && !input.inverses.has(command.nodeAddress)) {
          return refused('policy_gate', `${where} is not the inverse command the allow-list names for the command it reverts`);
        }
        if (transport === 'opcua') {
          const wrong = argumentsRefused(argumentsOf(entry.arguments), command.arguments ?? []);
          if (wrong !== undefined) return refused(wrong.stage, `${wrong.message} for ${where}`);
        }
        const point = points.find((p) => p.manifestId === found.connection.manifestId && p.address === command.nodeAddress);
        if (point === undefined) return refused('policy_gate', `the ${transport === 'mqtt' ? 'topic' : 'method'} for ${where} is not a declared writable point`);
        const check = await compileExpression('write.valueCheck', 'cel', point.valueCheck).evaluate({ values: target.newValues, prior: {} }, new Date());
        if (check !== true) return refused('intent', `the writable point's value check refuses the inputs for ${where}`);
        const last = await physicalWriteRepo.lastWritten(db, entry.id);
        if (input.dryRun !== true && last !== undefined && Date.now() - Date.parse(last) < entry.minIntervalSeconds * 1000) {
          return refused('plan', `${where} was sent less than ${entry.minIntervalSeconds} seconds ago`);
        }
        out.push({
          connectionId, reference: command.identifier, field: command.customAction, command: command.customAction, payload: command.payload ?? null, endpointId: null,
          nodeAddress: command.nodeAddress, entryId: entry.id, current: null,
          // A method's arguments as it would be called (D245); otherwise the inputs.
          proposed: (command.arguments ?? []).length > 0 ? Object.fromEntries(command.arguments!.map((a) => [a.name, a.value])) as never : target.newValues,
          simulatorAddress: input.dryRun === true ? entry.simulatorAddress : null, range: null, maxStep: null,
          minIntervalSeconds: entry.minIntervalSeconds, maxPerMinute: found.connection.maxPhysicalWritesPerMinute, lastWrittenAt: last ?? null,
        });
      }
      for (const node of resolved.nodes) {
        const target = targets.find((t) => t.entityReference === node.identifier)!;
        const where = `${node.field} on ${node.identifier}`;
        if (node.nodeAddress === null) return refused('policy_gate', `the node for ${where} is not on the server`);
        const entry = await actuationAllowlistRepo.liveFor(db, connectionId, 'opcua', node.nodeAddress);
        if (entry === undefined) return refused('policy_gate', `the node for ${where} is not in the connection's actuation allow-list`);
        if (entry.kind !== 'setpoint') return refused('policy_gate', `the node for ${where} is listed as a ${entry.kind}, not a setpoint`);
        if (input.dryRun === true && entry.simulatorAddress === null) {
          return refused('policy_gate', `the node for ${where} has no simulator node in its allow-list entry: it cannot be dry run`);
        }
        const proposed = target.newValues[node.field];
        const point = points.find((p) => p.manifestId === found.connection.manifestId && p.address === node.nodeAddress);
        if (point === undefined) return refused('policy_gate', `the node for ${where} is not a declared writable point`);
        const check = await compileExpression('write.valueCheck', 'cel', point.valueCheck)
          .evaluate({ values: { [node.field]: proposed }, prior: { [node.field]: node.current } }, new Date());
        if (check !== true) return refused('intent', `the writable point's value check refuses ${String(proposed)} for ${where}`);
        const value = numeric(proposed);
        if (entry.minValue !== null && (value === undefined || value < Number(entry.minValue) || value > Number(entry.maxValue))) {
          return refused('intent', `${String(proposed)} for ${where} is outside its allow-listed range ${entry.minValue} to ${entry.maxValue}`);
        }
        if (entry.maxStep !== null) {
          const now = numeric(node.current);
          if (value === undefined || now === undefined || Math.abs(value - now) > Number(entry.maxStep)) {
            return refused('intent', `${String(proposed)} for ${where} is a step of more than ${entry.maxStep} from its value now`);
          }
        }
        const last = await physicalWriteRepo.lastWritten(db, entry.id);
        if (input.dryRun !== true && last !== undefined && Date.now() - Date.parse(last) < entry.minIntervalSeconds * 1000) {
          return refused('plan', `${where} was written less than ${entry.minIntervalSeconds} seconds ago`);
        }
        out.push({
          connectionId, reference: node.identifier, field: node.field, command: null, payload: null, endpointId: null, nodeAddress: node.nodeAddress, entryId: entry.id,
          current: node.current, proposed,
          simulatorAddress: input.dryRun === true ? entry.simulatorAddress : null,
          range: entry.minValue === null ? null : { min: String(entry.minValue), max: String(entry.maxValue) }, maxStep: entry.maxStep === null ? null : String(entry.maxStep),
          minIntervalSeconds: entry.minIntervalSeconds, maxPerMinute: found.connection.maxPhysicalWritesPerMinute, lastWrittenAt: last ?? null,
        });
      }
      const rate = await withinRate(db, ctx, input, connectionId, found.connection.maxPhysicalWritesPerMinute, out.length);
      return rate ?? { nodes: out };
    });
    if ('refused' in checked) return checked;
    nodes.push(...checked.nodes);
  }
  // Physical webhooks (47.1): never on a dry run, which sends no webhook.
  if (input.dryRun !== true && (input.webhooks?.length ?? 0) > 0) {
    const checked = await inTransaction(control, ctx.request, (db) => webhookNodes(db, ctx, input));
    if ('refused' in checked) return checked;
    nodes.push(...checked.nodes);
  }
  return { nodes };
}

/** The connection's physical writes a minute (47.5): a plan beyond it is refused, and physical_rate_limit_refused raised. */
async function withinRate(db: Queryable, ctx: Context, input: { organisationId: string; actionTypeVersionId: string; dryRun?: boolean | undefined },
  connectionId: string, limit: number | null, planned: number): Promise<PhysicalPlan | undefined> {
  if (limit === null || input.dryRun === true || planned === 0) return undefined;
  const recent = await physicalWriteRepo.writtenSince(db, connectionId, new Date(Date.now() - 60_000).toISOString());
  if (recent + planned <= limit) return undefined;
  await recordActionEvent(db, {
    organisationId: input.organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions',
    event: 'physical_rate_limit_refused', resource: { type: 'connection', id: connectionId },
    detail: { limit, recent, planned, action_type_version_id: input.actionTypeVersionId },
  });
  return { refused: { stage: 'plan', reason: `the connection takes at most ${limit} physical writes a minute: ${recent} were written in the last minute and the plan writes ${planned}` } };
}

/** Each physical webhook target: listed as a command by its action's name, its point's check over the parameters, its interval and rate. */
async function webhookNodes(db: Queryable, ctx: Context, input: {
  organisationId: string; actionTypeVersionId: string; webhooks?: readonly string[] | undefined; parameters?: Record<string, unknown> | undefined;
  inverses?: ReadonlySet<string> | undefined;
}): Promise<PhysicalPlan> {
  const refused = (stage: 'policy_gate' | 'intent' | 'plan', reason: string): PhysicalPlan => ({ refused: { stage, reason } });
  const byConnection = new Map<string, { limit: number | null; nodes: PhysicalNode[] }>();
  for (const endpointId of new Set(input.webhooks ?? [])) {
    const endpoint = await webhookEndpointRepo.findById(db, endpointId);
    if (endpoint === undefined || endpoint.direction !== 'outbound' || endpoint.status !== 'active') return refused('policy_gate', 'a physical webhook target is not active');
    if (endpoint.riskClass !== 'physical' || endpoint.actionName === null) continue;
    const action = endpoint.actionName;
    const connection = (await connectionRepo.findById(db, endpoint.connectionId))!;
    const entry = await actuationAllowlistRepo.liveFor(db, connection.id, 'webhook', action);
    if (entry === undefined) return refused('policy_gate', `the webhook ${action} is not in the connection's actuation allow-list`);
    if (entry.kind !== 'command') return refused('policy_gate', `the webhook ${action} is listed as a ${entry.kind}, not a command`);
    if (input.inverses !== undefined && !input.inverses.has(action)) {
      return refused('policy_gate', `the webhook ${action} is not the inverse command the allow-list names for the command it reverts`);
    }
    const point = (await writablePointRepo.listForConnection(db, connection.id, false))
      .find((p) => p.manifestId === connection.manifestId && p.address === action && p.riskClass === 'physical');
    if (point === undefined) return refused('policy_gate', `the webhook ${action} is not a declared physical writable point`);
    const parameters = input.parameters ?? {};
    const check = await compileExpression('write.valueCheck', 'cel', point.valueCheck).evaluate({ values: parameters, prior: {} }, new Date());
    if (check !== true) return refused('intent', `the writable point's value check refuses the parameters for the webhook ${action}`);
    const last = await physicalWriteRepo.lastWritten(db, entry.id);
    if (last !== undefined && Date.now() - Date.parse(last) < entry.minIntervalSeconds * 1000) {
      return refused('plan', `the webhook ${action} was sent less than ${entry.minIntervalSeconds} seconds ago`);
    }
    const group = byConnection.get(connection.id) ?? { limit: connection.maxPhysicalWritesPerMinute, nodes: [] };
    group.nodes.push({
      connectionId: connection.id, reference: endpoint.id, field: action, command: action, payload: null, endpointId: endpoint.id, nodeAddress: action,
      simulatorAddress: null, entryId: entry.id, current: null, proposed: parameters, range: null, maxStep: null, minIntervalSeconds: entry.minIntervalSeconds,
      maxPerMinute: connection.maxPhysicalWritesPerMinute, lastWrittenAt: last ?? null,
    });
    byConnection.set(connection.id, group);
  }
  const nodes: PhysicalNode[] = [];
  for (const [connectionId, group] of byConnection) {
    const rate = await withinRate(db, ctx, input, connectionId, group.limit, group.nodes.length);
    if (rate !== undefined) return rate;
    nodes.push(...group.nodes);
  }
  return { nodes };
}

/**
 * At execution, before a physical webhook is queued (47.4, 47.5): its entry still listed, its
 * interval passed, the connection within its writes a minute; the cell's own check where no
 * agent sends it. Then the write is logged, outcome unknown: a webhook's effect is its target's.
 */
export async function queuePhysicalWebhook(db: Queryable, at: { organisationId: string; mutationId: string; connectionId: string; action: string })
  : Promise<{ refused: 'not_listed' | 'interval' | 'rate' } | { entry: { id: string; nodeAddress: string } }> {
  const entry = await actuationAllowlistRepo.liveFor(db, at.connectionId, 'webhook', at.action);
  if (entry === undefined || entry.kind !== 'command') return { refused: 'not_listed' };
  // Queued already, by an execution finished again: the same write, not another.
  if ((await physicalWriteRepo.listForMutation(db, at.mutationId)).some((w) => w.allowlistEntryId === entry.id)) return { entry: { id: entry.id, nodeAddress: entry.nodeAddress } };
  const last = await physicalWriteRepo.lastWritten(db, entry.id);
  if (last !== undefined && Date.now() - Date.parse(last) < entry.minIntervalSeconds * 1000) return { refused: 'interval' };
  const connection = await connectionRepo.findById(db, at.connectionId);
  const limit = connection?.maxPhysicalWritesPerMinute ?? null;
  if (limit !== null && await physicalWriteRepo.writtenSince(db, at.connectionId, new Date(Date.now() - 60_000).toISOString()) + 1 > limit) return { refused: 'rate' };
  await physicalWriteRepo.insert(db, {
    id: uuidv7(), organisationId: at.organisationId, connectionId: at.connectionId, mutationId: at.mutationId, allowlistEntryId: entry.id,
    nodeAddress: entry.nodeAddress, dryRun: false, outcome: 'unknown', reason: null,
  });
  return { entry: { id: entry.id, nodeAddress: entry.nodeAddress } };
}

/** The preview's physical block (47.3): the nodes, and the statement for what the Action is. */
export function physicalPreview(nodes: readonly PhysicalNode[], options: { notRevertible: boolean; dryRun: boolean }): Pick<Preview, 'physical'> {
  if (nodes.length === 0) return {};
  return {
    physical: {
      // A command that cannot be reverted says so; anything else carries the statement no configuration removes.
      statement: options.notRevertible && nodes.every((n) => n.command !== null) ? NOT_REVERTIBLE_STATEMENT : PHYSICAL_STATEMENT,
      ...(options.dryRun ? { dryRun: true } : {}),
      nodes: nodes.map((n) => ({
        connectionId: n.connectionId, reference: n.reference, field: n.field, nodeAddress: n.nodeAddress, current: (n.current ?? null) as never,
        ...(n.simulatorAddress === null ? {} : { simulatorAddress: n.simulatorAddress }),
        ...(n.command === null ? {} : { command: n.command }), ...(n.payload === null ? {} : { payload: n.payload }),
        ...(n.endpointId === null ? {} : { endpointId: n.endpointId }),
        proposed: (n.proposed ?? null) as never, range: n.range, maxStep: n.maxStep, minIntervalSeconds: n.minIntervalSeconds, maxPerMinute: n.maxPerMinute,
        lastWrittenAt: n.lastWrittenAt,
      })),
    },
  };
}

/**
 * The inverse commands a revert of a command may send (47.6): each the original's allow-list
 * entry names. A command sent whose entry names none cannot be reverted: the refusal says which.
 */
export async function inversesOf(db: Queryable, mutationId: string)
  : Promise<{ inverses: Set<string>; without: string[]; sentWebhooks: boolean; webhookTargets: string[] }> {
  const sent = (await physicalWriteRepo.listForMutation(db, mutationId)).filter((w) => !w.dryRun && (w.outcome === 'applied' || w.outcome === 'unknown'));
  const inverses = new Set<string>();
  const without: string[] = [];
  const webhookTargets: string[] = [];
  let sentWebhooks = false;
  for (const w of sent) {
    const entry = w.allowlistEntryId === null ? undefined : await actuationAllowlistRepo.findById(db, w.allowlistEntryId);
    // A setpoint is reverted by its prior value, not a command.
    if (entry?.kind === 'setpoint') continue;
    sentWebhooks ||= entry?.transport === 'webhook';
    if (entry?.inverseCommand === null || entry?.inverseCommand === undefined) {
      without.push(w.nodeAddress);
      continue;
    }
    inverses.add(entry.inverseCommand);
    // A physical webhook's inverse is another target of its connection, named for that action.
    if (entry.transport === 'webhook') {
      const target = await webhookEndpointRepo.liveAction(db, entry.connectionId, entry.inverseCommand);
      if (target === undefined || target.status !== 'active') {
        throw new AppError('conflict', `the inverse webhook ${entry.inverseCommand} has no active target: the command cannot be reverted now`, {
          code: 'revert.inverse_target_missing',
        });
      }
      webhookTargets.push(target.id);
    }
  }
  return { inverses, without, sentWebhooks, webhookTargets };
}

/** physical_action_proposed, with the mutation (47.8). */
export async function recordPhysicalProposed(db: Queryable, ctx: Context, input: { organisationId: string; mutationId: string; nodes: readonly PhysicalNode[] }) {
  await recordActionEvent(db, {
    organisationId: input.organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'physical_action_proposed',
    resource: { type: 'mutation', id: input.mutationId },
    detail: { nodes: input.nodes.length, entries: [...new Set(input.nodes.map((n) => n.entryId))].slice(0, 100), node: input.nodes[0]?.nodeAddress.slice(0, 200) ?? null },
  });
}

/** Every node a physical write named, and what became of it; the agent's refusals and the control system's rejections raised. */
export async function logPhysicalWrites(deps: WriteBackDeps, ctx: Context, at: { organisationId: string; connectionId: string; mutationId: string; dryRun?: boolean },
  results: readonly WriteResult[]): Promise<void> {
  const physical = results.filter((r) => r.physical !== undefined);
  if (physical.length === 0) return;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    for (const r of physical) {
      const refusedByAgent = r.error?.code === 'actuation.refused_by_agent';
      const rejected = r.error?.code === 'actuation.rejected_by_control_system';
      for (const n of r.physical!.nodes) {
        await physicalWriteRepo.insert(db, {
          id: uuidv7(), organisationId: at.organisationId, connectionId: at.connectionId, mutationId: at.mutationId,
          allowlistEntryId: uuid.test(n.entryId) ? n.entryId : null, nodeAddress: n.simulatorAddress ?? n.nodeAddress, dryRun: at.dryRun === true,
          outcome: refusedByAgent ? 'refused' : n.status === 'good' ? 'applied' : n.status === 'bad' ? 'rejected' : n.status === 'unknown' ? 'unknown' : 'not_written',
          reason: refusedByAgent && r.physical!.reason !== undefined && /^[a-z_]{1,40}$/.test(r.physical!.reason) ? r.physical!.reason : null,
        });
      }
      const event = { organisationId: at.organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions' as const, resource: { type: 'mutation' as const, id: at.mutationId } };
      if (refusedByAgent) {
        // The cell passed it; the agent's signed list did not. Never in normal operation.
        deps.logger.error('a physical write passed the cell but the agent refused it', {
          event: 'actuation.refused_by_agent', organisationId: at.organisationId, resourceId: at.mutationId, reason: r.physical!.reason ?? 'unknown',
        });
        await recordActionEvent(db, { ...event, event: 'physical_write_refused_by_agent', detail: { connection_id: at.connectionId, reason: r.physical!.reason ?? null, nodes: r.physical!.nodes.length } });
      }
      if (rejected) {
        await recordActionEvent(db, {
          ...event, event: 'physical_write_rejected_by_control_system',
          detail: { connection_id: at.connectionId, nodes: r.physical!.nodes.filter((n) => n.status === 'bad').length },
        });
      }
    }
  });
}

/**
 * physical_action_executed (47.8), read first by a reviewer: both approvers, the nodes' allow-list
 * entries and the receipt; a dry run's is physical_action_dry_run (47.5).
 */
export async function recordPhysicalExecuted(db: Queryable, ctx: Context, input: {
  organisationId: string; mutationId: string; receiptId: string; approvers: readonly string[]; dryRun?: boolean;
}) {
  const writes = (await physicalWriteRepo.listForMutation(db, input.mutationId)).filter((w) => w.outcome === 'applied' || w.outcome === 'unknown');
  await recordActionEvent(db, {
    organisationId: input.organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions',
    event: input.dryRun === true ? 'physical_action_dry_run' : 'physical_action_executed',
    resource: { type: 'mutation', id: input.mutationId },
    detail: {
      receipt_id: input.receiptId, approvers: [...input.approvers].slice(0, 100),
      entries: [...new Set(writes.flatMap((w) => (w.allowlistEntryId === null ? [] : [w.allowlistEntryId])))].slice(0, 100),
      node: writes[0]?.nodeAddress.slice(0, 200) ?? null, nodes: writes.length,
    },
  });
}
