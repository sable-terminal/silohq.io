// Sparkplug B (spec 20.2: "Sparkplug B as a built-in decoder"; D211): the Eclipse Tahu payload,
// a protocol buffer, read by hand from its wire format (no library), and its topic namespace
// spBv1.0/<group>/<message type>/<edge node>[/<device>].
//
// - A metric's value is read by its declared datatype: signed and unsigned integers of each
//   width, 64-bit ones as a string beyond 2^53, floats, booleans, strings, bytes as base64,
//   DateTime as milliseconds. DataSet, Template and the property and array types are kept by
//   name with no value and marked unsupported, never guessed.
// - A DATA message may name a metric by its alias only; the alias is defined by the edge
//   node's NBIRTH (or the device's DBIRTH). Aliases are kept per connection, edge node and
//   device, reset by a birth and cleared by a death; one not yet defined is left out and
//   counted, never resolved by guess.
// - Nothing here holds a value beyond the message it decodes: only names and aliases persist.

export const SPARKPLUG_NAMESPACE = 'spBv1.0';
export const SPARKPLUG_MESSAGE_TYPES = ['NBIRTH', 'NDEATH', 'DBIRTH', 'DDEATH', 'NDATA', 'DDATA', 'NCMD', 'DCMD', 'STATE'] as const;
type MessageType = (typeof SPARKPLUG_MESSAGE_TYPES)[number];

/** Tahu's DataType enumeration, by number. */
const DATATYPES: Readonly<Record<number, string>> = {
  0: 'Unknown', 1: 'Int8', 2: 'Int16', 3: 'Int32', 4: 'Int64', 5: 'UInt8', 6: 'UInt16', 7: 'UInt32', 8: 'UInt64', 9: 'Float', 10: 'Double',
  11: 'Boolean', 12: 'String', 13: 'DateTime', 14: 'Text', 15: 'UUID', 16: 'DataSet', 17: 'Bytes', 18: 'File', 19: 'Template',
  20: 'PropertySet', 21: 'PropertySetList',
};

export interface SparkplugMetric {
  name: string | null;
  alias: number | null;
  timestamp: number | null;
  datatype: string;
  value: string | number | boolean | null;
  isNull: boolean;
  isHistorical: boolean;
  isTransient: boolean;
  /** The datatype has no value the decoder reads (DataSet, Template, property sets, arrays). */
  unsupported: boolean;
}

export interface SparkplugPayload { timestamp: number | null; seq: number | null; uuid: string | null; metrics: SparkplugMetric[] }

export class SparkplugError extends Error {}

/** A protocol buffer read from its wire format: varints, fixed 32 and 64 bits, length-delimited. */
class Reader {
  private at = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  get done(): boolean { return this.at >= this.buf.length; }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.at >= this.buf.length) throw new SparkplugError('a varint runs past the end');
      const byte = this.buf[this.at++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new SparkplugError('a varint is longer than 64 bits');
    }
  }
  fixed32(): Buffer { return this.take(4); }
  fixed64(): Buffer { return this.take(8); }
  bytes(): Buffer { return this.take(Number(this.varint())); }
  private take(n: number): Buffer {
    if (n < 0 || this.at + n > this.buf.length) throw new SparkplugError('a field runs past the end');
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.fixed64();
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.fixed32();
    else throw new SparkplugError(`wire type ${wire} is not read`);
  }
  tag(): { field: number; wire: number } {
    const key = Number(this.varint());
    return { field: key >>> 3, wire: key & 7 };
  }
}

const big = (v: bigint): number | string => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString());

function readMetric(bytes: Buffer): SparkplugMetric {
  const r = new Reader(bytes);
  let name: string | null = null;
  let alias: number | null = null;
  let timestamp: number | null = null;
  let datatype = 0;
  let isHistorical = false;
  let isTransient = false;
  let isNull = false;
  let intValue: bigint | undefined;
  let longValue: bigint | undefined;
  let floatValue: number | undefined;
  let doubleValue: number | undefined;
  let boolValue: boolean | undefined;
  let stringValue: string | undefined;
  let bytesValue: Buffer | undefined;
  while (!r.done) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: name = r.bytes().toString('utf8'); break;
      case 2: alias = Number(r.varint()); break;
      case 3: timestamp = Number(r.varint()); break;
      case 4: datatype = Number(r.varint()); break;
      case 5: isHistorical = r.varint() !== 0n; break;
      case 6: isTransient = r.varint() !== 0n; break;
      case 7: isNull = r.varint() !== 0n; break;
      case 10: intValue = r.varint(); break;
      case 11: longValue = r.varint(); break;
      case 12: floatValue = r.fixed32().readFloatLE(0); break;
      case 13: doubleValue = r.fixed64().readDoubleLE(0); break;
      case 14: boolValue = r.varint() !== 0n; break;
      case 15: stringValue = r.bytes().toString('utf8'); break;
      case 16: bytesValue = Buffer.from(r.bytes()); break;
      default: r.skip(wire);
    }
  }
  const type = DATATYPES[datatype] ?? 'Unknown';
  let value: SparkplugMetric['value'] = null;
  let unsupported = false;
  if (!isNull) {
    const int = intValue === undefined ? undefined : Number(BigInt.asUintN(32, intValue));
    switch (datatype) {
      case 1: value = int === undefined ? null : (int << 24) >> 24; break;
      case 2: value = int === undefined ? null : (int << 16) >> 16; break;
      case 3: value = int === undefined ? null : int | 0; break;
      case 5: case 6: case 7: value = int ?? null; break;
      case 4: value = longValue === undefined ? null : big(BigInt.asIntN(64, longValue)); break;
      case 8: value = longValue === undefined ? null : big(BigInt.asUintN(64, longValue)); break;
      case 13: value = longValue === undefined ? null : Number(BigInt.asUintN(64, longValue)); break;
      case 9: value = floatValue ?? null; break;
      case 10: value = doubleValue ?? null; break;
      case 11: value = boolValue ?? null; break;
      case 12: case 14: case 15: value = stringValue ?? null; break;
      case 17: case 18: value = bytesValue === undefined ? null : bytesValue.toString('base64'); break;
      default: unsupported = true;
    }
  }
  return { name, alias, timestamp, datatype: type, value, isNull, isHistorical, isTransient, unsupported };
}

/** A Sparkplug B payload from its bytes; SparkplugError when they are not one. */
export function decodeSparkplug(bytes: Buffer): SparkplugPayload {
  const r = new Reader(bytes);
  const out: SparkplugPayload = { timestamp: null, seq: null, uuid: null, metrics: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) out.timestamp = Number(r.varint());
    else if (field === 2 && wire === 2) out.metrics.push(readMetric(r.bytes()));
    else if (field === 3 && wire === 0) out.seq = Number(r.varint());
    else if (field === 4 && wire === 2) out.uuid = r.bytes().toString('utf8');
    else r.skip(wire);
    if (out.metrics.length > 10_000) throw new SparkplugError('more than 10,000 metrics in one message');
  }
  return out;
}

export interface SparkplugTopic { groupId: string; messageType: MessageType; edgeNodeId: string; deviceId: string | null }

/** spBv1.0/<group>/<type>/<edge node>[/<device>]; undefined for any other topic (STATE has no edge node). */
export function sparkplugTopic(topic: string): SparkplugTopic | undefined {
  const levels = topic.split('/');
  if (levels[0] !== SPARKPLUG_NAMESPACE || levels.length < 4 || levels.length > 5) return undefined;
  const type = levels[2] as MessageType;
  if (!(SPARKPLUG_MESSAGE_TYPES as readonly string[]).includes(type) || type === 'STATE') return undefined;
  if (levels.slice(1).some((l) => l.length === 0)) return undefined;
  return { groupId: levels[1]!, messageType: type, edgeNodeId: levels[3]!, deviceId: levels[4] ?? null };
}

const MAX_NODES = 10_000;

/** Alias tables per scope (a connection), edge node and device, from births; cleared by deaths. */
export class SparkplugAliases {
  private readonly scopes = new Map<string, Map<string, Map<number, string>>>();

  private nodes(scope: string): Map<string, Map<number, string>> {
    let nodes = this.scopes.get(scope);
    if (nodes === undefined) this.scopes.set(scope, nodes = new Map());
    return nodes;
  }

  /** The metrics' names, by birth for the aliases a message names alone; how many stayed unresolved. */
  resolve(scope: string, topic: SparkplugTopic, payload: SparkplugPayload): { metrics: SparkplugMetric[]; unresolved: number } {
    const nodes = this.nodes(scope);
    const edge = `${topic.groupId}/${topic.edgeNodeId}`;
    const key = topic.deviceId === null ? edge : `${edge}/${topic.deviceId}`;
    if (topic.messageType === 'NBIRTH' || topic.messageType === 'NDEATH') {
      // A node's birth or death resets it and every device under it.
      for (const k of [...nodes.keys()]) if (k === edge || k.startsWith(`${edge}/`)) nodes.delete(k);
    } else if (topic.messageType === 'DBIRTH' || topic.messageType === 'DDEATH') {
      nodes.delete(key);
    }
    if (topic.messageType === 'NBIRTH' || topic.messageType === 'DBIRTH') {
      const table = new Map<number, string>();
      for (const m of payload.metrics) if (m.alias !== null && m.name !== null) table.set(m.alias, m.name);
      if (nodes.size >= MAX_NODES) nodes.delete(nodes.keys().next().value!);
      nodes.set(key, table);
    }
    const table = nodes.get(key);
    let unresolved = 0;
    const metrics: SparkplugMetric[] = [];
    for (const m of payload.metrics) {
      const name = m.name ?? (m.alias === null ? undefined : table?.get(m.alias));
      if (name === undefined) {
        unresolved += 1;
        continue;
      }
      metrics.push({ ...m, name });
    }
    return { metrics, unresolved };
  }
}
