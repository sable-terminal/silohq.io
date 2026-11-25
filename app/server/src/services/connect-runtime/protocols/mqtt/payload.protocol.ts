// An MQTT message's payload as its source declares it (spec 20.2; D211), for the snapshot read
// and the change stream alike: JSON (refused when it does not parse), declared-parse text, or
// Sparkplug B. A Sparkplug message is given to decode as
//   { messageType, groupId, edgeNodeId, deviceId, timestamp, seq, uuid, metrics: [...], values: { <metric>: value } }
// with every metric named (by its birth where the message gives only an alias); unsupported
// datatypes are kept with no value, and unresolved aliases are counted, never guessed.

import type { MqttSource } from '../../../../contracts/connect/manifest.contract.ts';
import { decodeSparkplug, SparkplugAliases, SparkplugError, sparkplugTopic } from './sparkplug.protocol.ts';

export type DecodedPayload = { ok: true; payload: unknown } | { ok: false; reason: 'not_json' | 'not_sparkplug' | 'not_sparkplug_topic' };

/** The process's alias tables: names and aliases only, per connection. */
const aliases = new SparkplugAliases();

export function decodeMqttPayload(source: Pick<MqttSource, 'payload'>, scope: string, topic: string, base64: string): DecodedPayload {
  const bytes = Buffer.from(base64, 'base64');
  if (source.payload === 'text') return { ok: true, payload: bytes.toString('utf8') };
  if (source.payload === 'json') {
    try {
      return { ok: true, payload: JSON.parse(bytes.toString('utf8')) };
    } catch {
      return { ok: false, reason: 'not_json' };
    }
  }
  const at = sparkplugTopic(topic);
  if (at === undefined) return { ok: false, reason: 'not_sparkplug_topic' };
  let decoded: ReturnType<typeof decodeSparkplug>;
  try {
    decoded = decodeSparkplug(bytes);
  } catch (error) {
    if (error instanceof SparkplugError || error instanceof RangeError) return { ok: false, reason: 'not_sparkplug' };
    throw error;
  }
  const { metrics, unresolved } = aliases.resolve(scope, at, decoded);
  const values: Record<string, unknown> = {};
  for (const m of metrics) if (!m.unsupported) values[m.name!] = m.value;
  return {
    ok: true,
    payload: {
      messageType: at.messageType, groupId: at.groupId, edgeNodeId: at.edgeNodeId, deviceId: at.deviceId,
      timestamp: decoded.timestamp, seq: decoded.seq, uuid: decoded.uuid, metrics, values, unresolvedAliases: unresolved,
    },
  };
}
