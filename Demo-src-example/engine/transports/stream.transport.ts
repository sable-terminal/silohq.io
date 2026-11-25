import { connect as netConnect } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import avro from 'avsc';
import { Kafka, logLevel, type ISocketFactory, type SASLOptions } from 'kafkajs';
import type { OperationV2, TransportV2, WriteOperationV2 } from '../../schemas/manifest.schema';
import { certificateFingerprint, nodeTls, sendHttp, socketLookup } from '../../infra/network.infra';
import { bounds, isAppError, refusal } from '../../utils/error.util';
import type { FormatOptions } from '../formats/contract.format';
import { parseBody } from '../formats/index.format';
import { bytesOf, WIRE_CONTENT_TYPE } from '../formats/wire.format';
import type { AuthSurface, SocketAuth, Transport, WireRequest, WireResponse } from './contract.transport';

/**
 * Kafka: a log you read, not a queue you drain (MANIFEST-V2 §9.11).
 *
 * ── BOUNDED AND REPEATABLE ────────────────────────────────────────────────
 *
 * A read starts at the offsets for `fromTime` — or the beginning — and ends at
 * the high-water marks captured when it began, so the same question asked
 * twice reads the same messages, and a busy topic cannot keep a read going
 * forever. When a page fills before the end, `x-silo-next` says where each
 * partition had got to and where it stops, and the connector's paging sends
 * that back as `body.position`.
 *
 * ── NOTHING IS COMMITTED ──────────────────────────────────────────────────
 *
 * The read joins a consumer group of its own, commits nothing, and deletes the
 * group afterwards. The customer's consumers never see Silo; their offsets are
 * untouched.
 *
 * ── WHAT A VALUE IS ───────────────────────────────────────────────────────
 *
 * The operation's `format` says what is inside each message. Avro in the
 * Confluent wire format finds its schema in the registry named on the
 * transport; Protocol Buffers uses the descriptor in `formatOptions`; JSON,
 * text, CSV and the rest go through the ordinary parsers. Bytes that are none of
 * those come back as a blob.
 */

export interface StreamWire extends WireRequest {
  kind: 'kafka';
  brokers: string[];
  clientId: string;
  plaintext: boolean;
  sasl: 'plain' | 'scram-sha-256' | 'scram-sha-512' | 'oauthbearer' | null;
  groupPrefix: string;
  topic: string;
  fromTime: string | null;
  /** `{ "<partition>": ["<next>", "<stop>"] }`, from the page before. */
  position: Record<string, [string, string]> | null;
  registry: string | null;
  values: { format: string; options: FormatOptions; charset: string };
  /** A write: the message to produce. */
  produce: { key: string | null; value: unknown; headers: Record<string, string> } | null;
}

/** Messages one page may hold. */
const PAGE_MESSAGES = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v));

function unbuildable(message: string): never {
  throw refusal({ message, code: 'refusal.request_unbuildable' });
}

function positionOf(body: unknown): StreamWire['position'] {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).position : null;
  if (raw === null || raw === undefined || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      unbuildable('A Kafka position is what x-silo-next said.');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) unbuildable('A Kafka position is what x-silo-next said.');
  const out: Record<string, [string, string]> = {};
  for (const [partition, range] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(partition) || !Array.isArray(range) || range.length !== 2 || !range.every((n) => /^\d+$/.test(String(n)))) {
      unbuildable('A Kafka position is what x-silo-next said.');
    }
    out[partition] = [String(range[0]), String(range[1])];
  }
  return out;
}

function socketOnly(where: string): never {
  throw refusal({ message: `A Kafka cluster takes its credential on the connection, not at ${where}.`, code: 'refusal.auth_place_unsupported' });
}

const surface = (socket: SocketAuth): AuthSurface => ({
  setHeader: (n) => socketOnly(`header:${n}`),
  setQuery: (n) => socketOnly(`query:${n}`),
  setBodyPath: (p) => socketOnly(`body:${p}`),
  setCookie: (n) => socketOnly(`cookie:${n}`),
  setForm: (n) => socketOnly(`form:${n}`),
  setSoapHeader: (p) => socketOnly(`soap:${p}`),
  socket,
});

/* ── Connecting ─────────────────────────────────────────────────────────── */

/**
 * EVERY BROKER THROUGH THE GUARD. A cluster tells its client which brokers to
 * talk to, and a hostile one could advertise the metadata server; the socket's
 * own lookup is the guard, so whatever is advertised is checked where it is
 * connected to.
 */
function socketFactory(socket: SocketAuth, inAgent: boolean): ISocketFactory {
  const lookup = socketLookup(inAgent);
  const pin = socket.tls.fingerprint;
  return ({ host, port, ssl, onConnect }) => {
    if (!ssl) return netConnect({ host, port, ...(lookup ? { lookup } : {}) }, onConnect);
    const tlsSocket: TLSSocket = tlsConnect(
      { ...(ssl as object), ...nodeTls(socket.tls, inAgent), host, port, servername: socket.tls.servername ?? host },
      () => {
        if (pin) {
          const seen = tlsSocket.getPeerCertificate().fingerprint256;
          if (!seen || certificateFingerprint(seen).replace(/=+$/, '') !== pin.replace(/=+$/, '')) {
            tlsSocket.destroy(new Error(`The broker presented a certificate (${seen ? certificateFingerprint(seen) : 'none'}) that is not the one pinned.`));
            return;
          }
        }
        onConnect();
      },
    );
    return tlsSocket;
  };
}

function saslOf(wire: StreamWire, socket: SocketAuth): SASLOptions | undefined {
  const mechanism = wire.sasl ?? (socket.accessToken ? 'oauthbearer' : socket.username ? 'plain' : null);
  if (!mechanism) return undefined;
  if (mechanism === 'oauthbearer') {
    const token = socket.accessToken;
    if (!token) throw refusal({ message: 'This Kafka connection signs in with OAuth and has no token.', code: 'refusal.credential_missing' });
    return { mechanism: 'oauthbearer', oauthBearerProvider: async () => ({ value: token }) };
  }
  if (!socket.username) throw refusal({ message: 'This Kafka connection has no username.', code: 'refusal.credential_missing' });
  return { mechanism, username: socket.username, password: socket.password ?? '' } as SASLOptions;
}

function clusterFor(wire: StreamWire, socket: SocketAuth, inAgent: boolean, timeoutMs: number): Kafka {
  if (wire.plaintext && !inAgent) {
    throw refusal({ message: 'An unencrypted Kafka cluster is only reached through the Silo agent.', code: 'refusal.plaintext' });
  }
  return new Kafka({
    clientId: wire.clientId,
    brokers: wire.brokers,
    ssl: wire.plaintext ? false : { rejectUnauthorized: !socket.tls.fingerprint },
    sasl: saslOf(wire, socket),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: Math.max(timeoutMs, CONNECT_TIMEOUT_MS),
    logLevel: logLevel.NOTHING,
    retry: { retries: 1 },
    socketFactory: socketFactory(socket, inAgent),
  });
}

/* ── Values ─────────────────────────────────────────────────────────────── */

/**
 * The Confluent wire format: a zero byte, a four-byte schema id, then the
 * payload — and, for Protocol Buffers, the indexes of the message type first.
 */
export function confluent(bytes: Buffer): { id: number; payload: Buffer } | null {
  if (bytes.length < 5 || bytes[0] !== 0) return null;
  return { id: bytes.readUInt32BE(1), payload: bytes.subarray(5) };
}

/** Skip the message-index list a Protocol Buffers value carries after its schema id. */
function afterIndexes(payload: Buffer): Buffer {
  let offset = 0;
  const varint = () => {
    let result = 0;
    for (let shift = 0; shift < 35 && offset < payload.length; shift += 7) {
      const byte = payload[offset++]!;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
    }
    return (result >>> 1) ^ -(result & 1);
  };
  const count = varint();
  for (let i = 0; i < count; i++) varint();
  return payload.subarray(offset);
}

function plain(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return bytesOf(value);
  if (Array.isArray(value)) return value.map((one) => plain(one, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v, depth + 1);
    return out;
  }
  return value;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A key is an identifier: text when it is text, a blob when it is not. Never parsed as the value is. */
function keyOf(key: Buffer | null): unknown {
  if (key === null) return null;
  try {
    return utf8.decode(key);
  } catch {
    return bytesOf(key);
  }
}

class ValueReader {
  private readonly schemas = new Map<number, avro.Type>();

  constructor(
    private readonly wire: StreamWire,
    private readonly socket: SocketAuth,
    private readonly inAgent: boolean,
  ) {}

  private async schema(id: number): Promise<avro.Type> {
    const known = this.schemas.get(id);
    if (known) return known;
    if (!this.wire.registry) {
      throw refusal({ message: 'These Avro values name a schema in a registry, and the connector names no registry.', code: 'refusal.request_unbuildable' });
    }
    const headers: Record<string, string> = { accept: 'application/vnd.schemaregistry.v1+json, application/json' };
    if (this.socket.registryUsername) {
      headers.authorization = `Basic ${Buffer.from(`${this.socket.registryUsername}:${this.socket.registryPassword ?? ''}`).toString('base64')}`;
    }
    const res = await sendHttp(
      { url: `${this.wire.registry.replace(/\/+$/, '')}/schemas/ids/${id}`, method: 'GET', headers, body: null },
      { tls: this.socket.tls, timeoutMs: CONNECT_TIMEOUT_MS, maxBytes: 1_000_000, retry: true, allowPrivate: this.inAgent },
    );
    if (res.status !== 200) {
      throw refusal({ message: `The schema registry answered ${res.status} for schema ${id}.`, code: res.status === 401 || res.status === 403 ? 'refusal.registry_auth' : 'refusal.registry_schema' });
    }
    const type = avro.Type.forSchema(JSON.parse(JSON.parse(res.body.toString('utf8')).schema as string), { wrapUnions: false });
    this.schemas.set(id, type);
    return type;
  }

  async read(bytes: Buffer | null): Promise<unknown> {
    if (bytes === null) return null;
    const { format, options, charset } = this.wire.values;
    if (format === 'binary') return bytesOf(bytes);
    if (format === 'avro') {
      const framed = confluent(bytes);
      if (!framed) throw refusal({ message: 'An Avro value without a schema id cannot be read. Silo reads the Confluent wire format.', code: 'refusal.request_unbuildable' });
      return plain((await this.schema(framed.id)).fromBuffer(framed.payload));
    }
    if (format === 'protobuf') {
      const framed = confluent(bytes);
      return parseBody({ bytes: framed ? afterIndexes(framed.payload) : bytes, format: 'protobuf', charset, contentType: null, options });
    }
    if (format === 'auto' || format === 'json') {
      const framed = format === 'json' ? confluent(bytes) : null;
      const body = framed ? framed.payload : bytes;
      let text: string;
      try {
        text = utf8.decode(body);
      } catch {
        if (format === 'json') throw refusal({ message: 'A value on this topic is not JSON.', code: 'refusal.request_unbuildable' });
        return bytesOf(bytes);
      }
      try {
        return JSON.parse(text);
      } catch {
        if (format === 'json') throw refusal({ message: 'A value on this topic is not JSON.', code: 'refusal.request_unbuildable' });
        return text;
      }
    }
    return parseBody({ bytes, format, charset, contentType: null, options });
  }
}

/* ── Reading ────────────────────────────────────────────────────────────── */

interface Range {
  next: bigint;
  stop: bigint;
}

async function rangesFor(kafka: Kafka, wire: StreamWire): Promise<Map<number, Range>> {
  const ranges = new Map<number, Range>();
  if (wire.position) {
    for (const [partition, [next, stop]] of Object.entries(wire.position)) ranges.set(Number(partition), { next: BigInt(next), stop: BigInt(stop) });
    return ranges;
  }
  const admin = kafka.admin();
  await admin.connect();
  try {
    const marks = await admin.fetchTopicOffsets(wire.topic);
    const starts = wire.fromTime
      ? new Map((await admin.fetchTopicOffsetsByTimestamp(wire.topic, Date.parse(wire.fromTime))).map((one) => [one.partition, one.offset]))
      : null;
    for (const mark of marks) {
      const high = BigInt(mark.high);
      const low = BigInt(mark.low);
      const at = starts?.get(mark.partition);
      const start = at === undefined || at === '-1' ? (starts ? high : low) : BigInt(at);
      ranges.set(mark.partition, { next: start < low ? low : start, stop: high });
    }
    return ranges;
  } finally {
    await admin.disconnect();
  }
}

async function readTopic(wire: StreamWire, socket: SocketAuth, inAgent: boolean, timeoutMs: number, maxBytes: number): Promise<WireResponse> {
  const started = Date.now();
  const kafka = clusterFor(wire, socket, inAgent, timeoutMs);
  const ranges = await rangesFor(kafka, wire);
  const open = new Map([...ranges].filter(([, r]) => r.next < r.stop));
  const reader = new ValueReader(wire, socket, inAgent);
  const messages: Array<Record<string, unknown>> = [];

  if (open.size > 0) {
    const groupId = `${wire.groupPrefix}-${crypto.randomUUID()}`;
    const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false, maxWaitTimeInMs: 250, retry: { retries: 1 } });
    let bytes = 0;
    let full = false;
    let failure: unknown = null;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    try {
      await consumer.connect();
      await consumer.subscribe({ topics: [wire.topic], fromBeginning: true });
      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: async ({ batch }) => {
          const range = open.get(batch.partition);
          if (!range || full) return;
          try {
            for (const m of batch.messages) {
              const offset = BigInt(m.offset);
              if (offset < range.next || offset >= range.stop) continue;
              if (messages.length >= PAGE_MESSAGES) {
                full = true;
                break;
              }
              bytes += (m.value?.length ?? 0) + (m.key?.length ?? 0);
              if (bytes > maxBytes) {
                if (messages.length === 0) throw bounds({ message: `A message on ${wire.topic} is larger than one question may read.`, code: 'bounds.bytes', detail: { limit: maxBytes } });
                full = true;
                break;
              }
              messages.push({
                topic: batch.topic,
                partition: batch.partition,
                offset: m.offset,
                timestamp: new Date(Number(m.timestamp)).toISOString(),
                key: keyOf(m.key),
                headers: Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k, v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v)])),
                value: await reader.read(m.value),
              });
              range.next = offset + 1n;
            }
          } catch (error) {
            failure = error;
            settle();
            return;
          }
          if (range.next >= range.stop) open.delete(batch.partition);
          if (open.size === 0 || full) settle();
        },
      });
      for (const [partition, range] of open) consumer.seek({ topic: wire.topic, partition, offset: range.next.toString() });
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    } finally {
      await consumer.disconnect().catch(() => {});
      const admin = kafka.admin();
      await admin
        .connect()
        .then(() => admin.deleteGroups([groupId]))
        .catch(() => {})
        .finally(() => admin.disconnect().catch(() => {}));
    }
    if (failure) throw failure;
    if (messages.length === 0 && open.size > 0) {
      return { status: null, code: 'TIMEOUT', message: `Nothing arrived from ${wire.topic} in time.`, headers: {}, body: Buffer.alloc(0), contentType: null, durationMs: Date.now() - started };
    }
  }

  messages.sort((a, b) => Number(a.partition) - Number(b.partition) || (BigInt(a.offset as string) < BigInt(b.offset as string) ? -1 : 1));
  const remaining = [...ranges].filter(([, r]) => r.next < r.stop);
  const next = remaining.length > 0 ? JSON.stringify(Object.fromEntries(remaining.map(([p, r]) => [String(p), [r.next.toString(), r.stop.toString()]]))) : null;
  return {
    status: null,
    code: null,
    message: null,
    headers: { 'x-topic': wire.topic, ...(next ? { 'x-silo-next': next } : {}) },
    body: Buffer.from(JSON.stringify(messages)),
    contentType: WIRE_CONTENT_TYPE,
    durationMs: Date.now() - started,
  };
}

async function produce(wire: StreamWire, socket: SocketAuth, inAgent: boolean, timeoutMs: number): Promise<WireResponse> {
  const started = Date.now();
  const message = wire.produce!;
  const kafka = clusterFor(wire, socket, inAgent, timeoutMs);
  const producer = kafka.producer({ allowAutoTopicCreation: false, retry: { retries: 0 } });
  await producer.connect();
  try {
    const [meta] = await producer.send({
      topic: wire.topic,
      acks: -1,
      timeout: timeoutMs,
      messages: [{ key: message.key, value: typeof message.value === 'string' ? message.value : JSON.stringify(message.value ?? null), headers: message.headers }],
    });
    const body = { topic: wire.topic, partition: meta?.partition ?? null, offset: meta?.baseOffset ?? null };
    return { status: null, code: null, message: null, headers: {}, body: Buffer.from(JSON.stringify(body)), contentType: WIRE_CONTENT_TYPE, durationMs: Date.now() - started };
  } finally {
    await producer.disconnect().catch(() => {});
  }
}

/**
 * What a Kafka error means. kafkajs names the protocol's error in `type`, but
 * often on an error it has wrapped — a retry that gave up carries the real one
 * as its cause — so the chain is walked.
 */
function codeOf(error: unknown): string {
  for (let e = error as { type?: string; name?: string; message?: string; cause?: unknown; originalError?: unknown } | undefined, depth = 0; e && depth < 5; depth++) {
    if (e.type) return e.type;
    if (e.name === 'KafkaJSSASLAuthenticationError') return 'SASL_AUTHENTICATION_FAILED';
    if (/does not host this topic-partition|unknown topic/i.test(e.message ?? '')) return 'UNKNOWN_TOPIC_OR_PARTITION';
    if (/not authorized|authorization failed/i.test(e.message ?? '')) return 'TOPIC_AUTHORIZATION_FAILED';
    if (e.name === 'KafkaJSRequestTimeoutError' || e.name === 'KafkaJSConnectionError' || /timeout|timed out/i.test(e.message ?? '')) return 'TIMEOUT';
    e = (e.cause ?? e.originalError) as typeof e;
  }
  return 'ERROR';
}

export const kafka: Transport<StreamWire> = {
  kind: 'kafka',
  writes: true,
  answersWire: true,

  prepare({ transport, request, operation }) {
    const t = transport as Extract<TransportV2, { kind: 'kafka' }>;
    const brokers = (request.connection.brokers as unknown[] | undefined ?? []).map((one) => str(one)).filter(Boolean);
    if (brokers.length === 0) unbuildable('A Kafka connector names at least one broker.');
    if (!request.topic) unbuildable('A Kafka read names its topic.');
    const op = operation as Partial<OperationV2 & WriteOperationV2> & { format?: string; formatOptions?: FormatOptions; charset?: string };
    /* A read's body is where to resume; a write's is the message: { key, value, headers }. */
    const body = (request.body ?? {}) as Record<string, unknown>;
    let produced: StreamWire['produce'] = null;
    if ('value' in body) {
      produced = {
        key: body.key === undefined || body.key === null ? null : String(body.key),
        value: body.value ?? null,
        headers: Object.fromEntries(Object.entries((body.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
      };
    }
    return {
      kind: 'kafka',
      brokers,
      clientId: str(request.connection.clientId, 'silo'),
      plaintext: t.security === 'none',
      sasl: t.sasl ?? null,
      groupPrefix: t.groupPrefix,
      topic: request.topic,
      fromTime: request.fromTime ?? null,
      position: produced ? null : positionOf(request.body),
      registry: request.connection.schemaRegistry === undefined || request.connection.schemaRegistry === null ? null : str(request.connection.schemaRegistry),
      values: { format: op.format ?? 'auto', options: op.formatOptions ?? {}, charset: op.charset ?? 'auto' },
      produce: produced,
    };
  },

  authSurface: (_wire, socket) => surface(socket),

  async send(wire, options) {
    const started = Date.now();
    try {
      if (options.mode === 'write') {
        if (!wire.produce) unbuildable('A Kafka write says what to send: body { key, value, headers }.');
        return await produce(wire, options.socket, options.inAgent === true, options.timeoutMs);
      }
      return await readTopic(wire, options.socket, options.inAgent === true, options.timeoutMs, options.maxBytes);
    } catch (error) {
      if (isAppError(error)) throw error;
      return { status: null, code: codeOf(error), message: (error instanceof Error ? error.message : String(error)).slice(0, 500), headers: {}, body: Buffer.alloc(0), contentType: null, durationMs: Date.now() - started };
    }
  },

  floor(res) {
    if (res.code === null) return null;
    if (/AUTHORIZATION_FAILED|AUTHENTICATION|SASL/.test(res.code)) return { means: 'auth' };
    if (res.code === 'UNKNOWN_TOPIC_OR_PARTITION') return { means: 'not_found' };
    if (/THROTTL|QUOTA/.test(res.code)) return { means: 'rate_limit' };
    if (res.code === 'TIMEOUT') return { means: 'bounds' };
    return { means: 'upstream' };
  },
};
