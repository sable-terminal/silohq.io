// OPC UA setpoint writes and method calls (spec 47.1, 47.4 to 47.6): the cell's half of
// opcua.write and opcua.call. Each operation is one record (an instance under the object's root,
// named by its identifier, the browse name): for a setpoint, the values for the variables at its
// fields' browse paths; for a command, the method its custom action names, called on its parent.
// The statements go to the agent on the grant actions signed for exactly them; the agent checks
// each node against its signed allow-list, the entry's range, step and interval, and the
// connection's writes a minute, and writes or calls nothing if any is refused. A node the control
// system refuses is failed and never retried; read back then verifies what landed, and a command
// is verified by its acknowledgement, which does not confirm the physical outcome.

import type { SignedExecutionGrant } from '../../../../contracts/actions/grant.contract.ts';
import type { CustomAction, ManifestObject, MethodArgumentType, OpcUaSource } from '../../../../contracts/connect/manifest.contract.ts';
import type { WriteResult } from '../../../../contracts/connect-runtime/write.contract.ts';
import type { Connection } from '../../../../models/connect/connection.model.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { pemToDerBase64 } from '../../../../utils/pem.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import type { AgentCallStatement, AgentPhysicalStatement } from '../../agent.service.ts';
import type { ReadContext } from '../../engine.service.ts';
import { physicalOutcomes, type PhysicalWriteResult } from '../physical.protocol.ts';

interface Operation {
  key: string;
  identifier?: string | undefined;
  values: Record<string, unknown>;
  customAction?: string | undefined;
}

/** The statements the agent writes and the grant covers, exactly as they are sent. */
export function opcuaStatements(connection: Pick<Connection, 'maxPhysicalWritesPerMinute'>, object: ManifestObject, operations: readonly Operation[],
  dryRun = false): AgentPhysicalStatement[] {
  const identifier = object.identifier[0]!;
  return operations.map((op) => ({
    key: op.key,
    instance: op.identifier!,
    writes: Object.entries(op.values).filter(([field]) => field !== identifier).map(([field, value]) => {
      const path = object.fields.find((f) => f.name === field)?.path ?? field;
      if (path.startsWith('$')) {
        throw new AppError('validation', 'an instance\'s browse name and node are not written', { code: 'write.field_not_writable', details: { field } });
      }
      return { path, value: value ?? null };
    }),
    maxPerMinute: connection.maxPhysicalWritesPerMinute ?? 0,
    ...(dryRun ? { dryRun: true as const } : {}),
  }));
}

const INTEGER_BOUNDS: Partial<Record<MethodArgumentType, [number, number]>> = {
  SByte: [-128, 127], Byte: [0, 255], Int16: [-32_768, 32_767], UInt16: [0, 65_535], Int32: [-2_147_483_648, 2_147_483_647], UInt32: [0, 4_294_967_295],
  Int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/** Whether a JSON value is one of an OPC UA built-in type (the agent converts it, and checks again). */
function fits(type: MethodArgumentType, value: unknown): boolean {
  if (type === 'Boolean') return typeof value === 'boolean';
  if (type === 'String') return typeof value === 'string' && value.length <= 4_096;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const bounds = INTEGER_BOUNDS[type];
  return bounds === undefined || (Number.isInteger(value) && value >= bounds[0] && value <= bounds[1]);
}

/**
 * A method's input arguments (47.1, D245), in its order, each of its declared type: the body's
 * JSONata over the inputs, by the names the method declares; or without a body, each from the input
 * the manifest names for it. A value for an argument it does not take, or none for one it does, is
 * refused: nothing is guessed.
 */
export async function methodArguments(declared: CustomAction, inputs: Record<string, unknown>,
  at: { identifier: string | null; params: Record<string, unknown>; now: Date }): Promise<{ name: string; value: unknown }[]> {
  const takes = declared.opcua?.arguments ?? [];
  const refuse = (message: string, code: string): never => { throw new AppError('validation', message, { code }); };
  if (takes.length === 0) {
    if (Object.keys(inputs).length > 0) refuse(`the method of ${declared.name} takes no input arguments`, 'write.arguments_unexpected');
    return [];
  }
  const value = declared.body === undefined ? Object.fromEntries(Object.entries(inputs).map(([k, v]) => [takes.find((a) => (a.input ?? a.name) === k)?.name ?? k, v]))
    : await compileExpression('write.body', 'jsonata', declared.body.jsonata).evaluate({ input: inputs, identifier: at.identifier, params: at.params }, at.now);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(`the body of ${declared.name} gives the method's input arguments by name`, 'write.arguments_shape');
  const given = value as Record<string, unknown>;
  const extra = Object.keys(given).find((k) => !takes.some((a) => a.name === k));
  if (extra !== undefined) refuse(`the method of ${declared.name} takes no argument ${extra}`, 'write.argument_unknown');
  return takes.map((a) => {
    const v = given[a.name];
    if (v === undefined || v === null) refuse(`the argument ${a.name} of ${declared.name} has no value`, 'write.argument_missing');
    if (!fits(a.type, v)) refuse(`the argument ${a.name} is not ${/^[AEIOU]/.test(a.type) ? 'an' : 'a'} ${a.type}`, 'write.argument_type');
    return { name: a.name, value: v };
  });
}

/** The commands the agent calls and the grant covers (47.1): each record's method, by browse path under its instance, with its input arguments in order. */
export async function opcuaCallStatements(ctx: ReadContext, connection: Pick<Connection, 'maxPhysicalWritesPerMinute'>, object: ManifestObject,
  operations: readonly Operation[], options: { dryRun: boolean; at: Date }): Promise<AgentCallStatement[]> {
  const statements: AgentCallStatement[] = [];
  for (const op of operations) {
    const declared = object.writes?.custom.find((c) => c.name === op.customAction);
    if (declared?.opcua === undefined) {
      throw new AppError('validation', `the manifest declares no method ${op.customAction ?? ''} on ${object.name}`, { code: 'write.operation_undeclared', details: { operation: 'custom' } });
    }
    const args = await methodArguments(declared, op.values, { identifier: op.identifier ?? null, params: ctx.params, now: options.at });
    statements.push({
      key: op.key, instance: op.identifier!, method: declared.opcua.method, inputs: args.map((a) => a.value), maxPerMinute: connection.maxPhysicalWritesPerMinute ?? 0,
      ...(options.dryRun ? { dryRun: true as const } : {}),
    });
  }
  return statements;
}

/** How the agent reaches the server: the active endpoint, and for a signed policy its certificate and the server's pin. */
function serverOf(ctx: ReadContext, connection: Connection) {
  const industrial = ctx.industrial;
  if (industrial === undefined || industrial.plugin !== 'opcua') {
    throw new AppError('conflict', 'the connection has no active server: create its industrial endpoint and, for a signed policy, verify it', {
      code: 'industrial.endpoint_missing',
    });
  }
  if (connection.agentPoolId === null) throw new AppError('source_unreachable', 'OPC UA is written through the connection\'s Silo Agent', { code: 'agent.unavailable' });
  const signed = industrial.securityPolicy === 'None' || industrial.appCertificatePem === null || industrial.serverCertificateThumbprint === null ? undefined
    : { endpointId: industrial.id, certificate: pemToDerBase64(industrial.appCertificatePem), serverThumbprint: industrial.serverCertificateThumbprint };
  return {
    organisationId: connection.organisationId, connectionId: connection.id, agentPoolId: connection.agentPoolId,
    endpointUrl: industrial.endpointUrl, securityPolicy: industrial.securityPolicy, signed,
    timeoutMs: Math.max(1_000, Math.min(60_000, ctx.deadline - performance.now())), signal: ctx.signal, sealLogin: ctx.manifest.auth.strategy !== 'none',
  };
}

export async function opcuaWrite(ctx: ReadContext, connection: Connection, object: ManifestObject, operations: readonly Operation[],
  grant: SignedExecutionGrant | undefined, dryRun = false): Promise<PhysicalWriteResult[]> {
  const source = object.source as OpcUaSource;
  const server = serverOf(ctx, connection);
  if (ctx.agent.opcuaWrite === undefined) throw new AppError('source_unreachable', 'OPC UA is written through the connection\'s Silo Agent', { code: 'agent.unavailable' });
  const rows = await ctx.agent.opcuaWrite({
    ...server, root: source.root, ...(source.typeDefinition === undefined ? {} : { typeDefinition: source.typeDefinition }),
    statements: opcuaStatements(connection, object, operations, dryRun), grant,
  });
  // Each node named by the field it stands for: a dry run is verified from what the simulator read back (47.5).
  return physicalOutcomes(operations, rows, (path) => object.fields.find((f) => (f.path ?? f.name) === path)?.name);
}

/** Commands (47.1): each record's method called through the agent, the statements the grant covers; verified by acknowledgement (47.6). */
export async function opcuaCall(ctx: ReadContext, connection: Connection, object: ManifestObject, operations: readonly Operation[],
  statements: AgentCallStatement[], grant: SignedExecutionGrant | undefined): Promise<PhysicalWriteResult[]> {
  const source = object.source as OpcUaSource;
  const server = serverOf(ctx, connection);
  if (ctx.agent.opcuaCall === undefined) throw new AppError('source_unreachable', 'OPC UA is called through the connection\'s Silo Agent', { code: 'agent.unavailable' });
  const rows = await ctx.agent.opcuaCall({
    ...server, root: source.root, ...(source.typeDefinition === undefined ? {} : { typeDefinition: source.typeDefinition }),
    statements, grant,
  });
  return physicalOutcomes(operations, rows);
}
