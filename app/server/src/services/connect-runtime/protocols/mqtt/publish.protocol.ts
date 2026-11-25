// MQTT commands (spec 47.1, 47.4 to 47.6, 20.2): the cell's half of mqtt.publish. Each
// operation is one record's command: its custom action's topic with {identifier} the record's
// identifier (one whole level), and its payload, the body's result over the inputs (or the
// inputs themselves), checked against the declared payload schema before anything is sent: a
// JSON object of exactly the declared keys and types, or text. The statements go to the agent on
// the grant actions signed for exactly them; the agent checks each topic against its signed
// allow-list, the entry's interval and the connection's writes a minute, and publishes nothing if
// any is refused. The broker's acknowledgement verifies a command; it does not confirm the
// physical outcome (47.6). The payload is computed at the plan's moment, so the statements
// prepared for the grant are the statements published.

import type { SignedExecutionGrant } from '../../../../contracts/actions/grant.contract.ts';
import type { CustomAction, ManifestObject, MqttCommand } from '../../../../contracts/connect/manifest.contract.ts';
import type { Connection } from '../../../../models/connect/connection.model.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import type { AgentPublishStatement } from '../../agent.service.ts';
import type { ReadContext } from '../../engine.service.ts';
import { physicalOutcomes, type PhysicalWriteResult } from '../physical.protocol.ts';

interface Operation {
  key: string;
  identifier?: string | undefined;
  values: Record<string, unknown>;
  customAction?: string | undefined;
}

/** The custom action an operation publishes, as the manifest declares it. */
export function commandOf(object: ManifestObject, customAction: string | undefined): CustomAction & { mqtt: MqttCommand } {
  const declared = object.writes?.custom.find((c) => c.name === customAction);
  if (declared?.mqtt === undefined) {
    throw new AppError('validation', `the manifest declares no command ${customAction ?? ''} on ${object.name}`, { code: 'write.operation_undeclared', details: { operation: 'custom' } });
  }
  return declared as CustomAction & { mqtt: MqttCommand };
}

/** The topic a record's command is published to: {identifier} its identifier, which must be one whole topic level. */
export function commandTopic(command: MqttCommand, identifier: string | undefined): string {
  return command.topic.split('/').map((level, i) => {
    if (level !== '{identifier}') return level;
    if (identifier === undefined || identifier === '' || /[/+#\u0000]/.test(identifier) || (i === 0 && identifier.startsWith('$'))) {
      throw new AppError('validation', 'the record\'s identifier is not one MQTT topic level', { code: 'write.topic_level' });
    }
    return identifier;
  }).join('/');
}

const TYPES: Record<MqttCommand['schema'][number]['type'], (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isSafeInteger(v),
  boolean: (v) => typeof v === 'boolean',
};

/** The payload exactly as published, from the body's result: refused where it is not what the schema declares. */
export function commandPayload(command: MqttCommand, value: unknown): string {
  const refuse = (why: string, key?: string): never => {
    throw new AppError('validation', `the command's payload is not what its schema declares: ${why}`, {
      code: 'write.payload_schema', ...(key === undefined ? {} : { details: { key } }),
    });
  };
  if (command.payload === 'text') {
    if (typeof value !== 'string') refuse('a text payload is a string');
    return value as string;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse('a JSON payload is an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!command.schema.some((k) => k.name === key)) refuse(`${key} is not a declared key`, key);
  }
  for (const k of command.schema) {
    const v = record[k.name];
    if (v === undefined || v === null) {
      if (k.required) refuse(`${k.name} is required`, k.name);
      continue;
    }
    if (!TYPES[k.type](v)) refuse(`${k.name} is not a${k.type === 'integer' ? 'n' : ''} ${k.type}`, k.name);
  }
  return JSON.stringify(record);
}

/** The commands the agent publishes and the grant covers, computed at the plan's moment. */
export async function mqttStatements(ctx: ReadContext, connection: Pick<Connection, 'maxPhysicalWritesPerMinute'>, object: ManifestObject,
  operations: readonly Operation[], options: { dryRun: boolean; at: Date }): Promise<AgentPublishStatement[]> {
  const statements: AgentPublishStatement[] = [];
  for (const op of operations) {
    const declared = commandOf(object, op.customAction);
    const value = declared.body === undefined ? op.values
      : await compileExpression('write.body', 'jsonata', declared.body.jsonata).evaluate({ input: op.values, identifier: op.identifier ?? null, params: ctx.params }, options.at);
    statements.push({
      key: op.key, topic: commandTopic(declared.mqtt, op.identifier), payload: commandPayload(declared.mqtt, value),
      qos: declared.mqtt.qos, retained: declared.mqtt.retained, maxPerMinute: connection.maxPhysicalWritesPerMinute ?? 0,
      ...(options.dryRun ? { dryRun: true as const } : {}),
    });
  }
  return statements;
}

/** Commands (47.1): published through the agent to the connection's broker, on the grant; verified by acknowledgement (47.6). */
export async function mqttPublish(ctx: ReadContext, connection: Connection, operations: readonly Operation[], statements: AgentPublishStatement[],
  grant: SignedExecutionGrant | undefined): Promise<PhysicalWriteResult[]> {
  if (ctx.industrial === undefined || ctx.industrial.plugin !== 'mqtt') {
    throw new AppError('conflict', 'the connection has no active broker: create its industrial endpoint', { code: 'industrial.endpoint_missing' });
  }
  if (ctx.agent.mqttPublish === undefined || connection.agentPoolId === null) {
    throw new AppError('source_unreachable', 'MQTT is published through the connection\'s Silo Agent', { code: 'agent.unavailable' });
  }
  const rows = await ctx.agent.mqttPublish({
    organisationId: connection.organisationId, connectionId: connection.id, agentPoolId: connection.agentPoolId, endpointUrl: ctx.industrial.endpointUrl,
    statements, grant, timeoutMs: Math.max(1_000, Math.min(60_000, ctx.deadline - performance.now())), signal: ctx.signal,
    sealLogin: ctx.manifest.auth.strategy !== 'none',
  });
  return physicalOutcomes(operations, rows);
}
