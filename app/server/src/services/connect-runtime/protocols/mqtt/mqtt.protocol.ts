// The MQTT protocol engine (spec 20.2), the cell's half of the agent's plugin: the agent
// subscribes on the customer's network and returns the broker's retained messages on the
// object's topic filter (the backfill of 18.5); the cell decodes each with the manifest's
// JSONata and reads the fields by their paths. Live telemetry arrives through the change
// stream, not here.
//
// - The broker is the connection's active industrial endpoint (20.7), reached only by the
//   connection's agent pool. A login, where the manifest declares one, is sealed to the
//   agent for this read alone.
// - A payload is JSON, text or Sparkplug B as the source declares (payload.protocol.ts); a
//   message that does not parse as declared is refused with its topic, never guessed. decode
//   gives the record, or null to skip a message.
// - More messages than the step may read are refused, never truncated (the agent reports
//   when it stopped early, and that is refused too).

import type { ManifestField, ManifestObject, MqttSource } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { decodeMqttPayload } from './payload.protocol.ts';
import { coerce, getPath, rowsBound, type ProtocolEngine, type ReadContext, type Row } from '../../engine.service.ts';

export const mqttEngine: ProtocolEngine = {
  async read(ctx: ReadContext, object: ManifestObject, _native, fields: readonly ManifestField[]): Promise<Row[]> {
    const source = object.source as MqttSource;
    if (ctx.industrial === undefined || ctx.industrial.plugin !== 'mqtt') {
      throw new AppError('conflict', 'the connection has no active broker: create its industrial endpoint', { code: 'industrial.endpoint_missing' });
    }
    if (ctx.connection.agentPoolId === null || ctx.agent.mqtt === undefined) {
      throw new AppError('source_unreachable', 'MQTT is read through the connection\'s Silo Agent', { code: 'agent.unavailable' });
    }
    const remaining = Math.max(1_000, ctx.deadline - performance.now());
    const out = await ctx.agent.mqtt({
      organisationId: ctx.connection.organisationId, connectionId: ctx.connection.id, agentPoolId: ctx.connection.agentPoolId,
      endpointUrl: ctx.industrial.endpointUrl, topics: [{ filter: source.topic, qos: source.qos }], windowMs: source.snapshotMs,
      maxMessages: ctx.maxRows + 1, timeoutMs: Math.min(remaining, source.snapshotMs + 30_000), signal: ctx.signal,
      sealLogin: ctx.manifest.auth.strategy !== 'none',
    });
    if (out.truncated || out.messages.length > ctx.maxRows) throw rowsBound(ctx);
    const decode = compileExpression('source.decode', 'jsonata', source.decode.jsonata);
    const rows: Row[] = [];
    for (const message of out.messages) {
      const decoded = decodeMqttPayload(source, ctx.connection.id, message.topic, message.payload);
      if (!decoded.ok) {
        const what = decoded.reason === 'not_json' ? 'JSON' : decoded.reason === 'not_sparkplug_topic' ? 'on a Sparkplug B topic' : 'a Sparkplug B payload';
        throw new AppError('validation', `a message on ${message.topic.slice(0, 200)} is not ${what}`, {
          code: 'mqtt.payload_invalid', details: { topic: message.topic.slice(0, 200), reason: decoded.reason },
        });
      }
      const payload = decoded.payload;
      const record = await decode.evaluate({ input: { topic: message.topic.split('/'), payload, receivedAt: message.receivedAt }, params: ctx.params }, ctx.now);
      if (record === null || record === undefined) continue;
      ctx.stats.sourceRows += 1;
      const row: Row = {};
      for (const field of fields) row[field.name] = coerce(getPath(record, field.path ?? field.name), field.type, ctx.stats);
      rows.push(row);
    }
    ctx.stats.pages += 1;
    return rows;
  },
};
