import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import type { TransportV2 } from '../../schemas/manifest.schema';
import { BlockedAddress, resolveGuarded } from '../../infra/network.infra';
import { bounds, isAppError, refusal, upstream } from '../../utils/error.util';
import { FormatError } from '../formats/contract.format';
import { encode, plainOf, rootOf } from '../formats/protobuf.format';
import { WIRE_CONTENT_TYPE } from '../formats/wire.format';
import type { AuthSurface, SocketAuth, Structure, Transport, WireRequest, WireResponse } from './contract.transport';

/**
 * gRPC: a service, a method, and a message.
 *
 * ── THE SCHEMA COMES FROM THE SERVER OR THE DOCUMENT, NEVER FROM SILO ─────
 *
 * A gRPC call cannot be made without knowing the message types. They come from
 * the descriptor set the connector carries, or — when the server offers it —
 * from server reflection, asked at call time for the one service named. Either
 * way nothing about any particular system is compiled into Silo.
 *
 * ── THE REQUEST IS JSON, THE ANSWER IS JSON ───────────────────────────────
 *
 * `body` is the request message as the proto3 JSON mapping writes it, built by
 * expressions like any body; the answer is the response message the same way,
 * or a list of them for a server-streaming method. Paging is the service's own
 * `page_token`, written into `next.body` like any cursor.
 *
 * ── CLIENT AND BIDIRECTIONAL STREAMS ARE REFUSED ──────────────────────────
 *
 * A read is a question and an answer. A method that wants a stream of requests
 * is not a read, and is refused by name.
 */

export interface GrpcWire extends WireRequest {
  kind: 'grpc';
  host: string;
  port: number;
  plaintext: boolean;
  service: string;
  rpc: string;
  message: unknown;
  metadata: Record<string, string>;
  descriptor: string | null;
  reflection: boolean;
}

/** Messages one server stream may send before the read is refused as too large. */
const MAX_STREAMED = 200_000;

const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v));

function unbuildable(message: string): never {
  throw refusal({ message, code: 'refusal.request_unbuildable' });
}

function addressOf(address: string): { host: string; port: number } {
  const trimmed = address.replace(/^(grpcs?|https?|dns):\/\/\/?/, '');
  const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed) ?? /^([^:]+)(?::(\d+))?$/.exec(trimmed);
  if (!match) unbuildable(`"${address.slice(0, 100)}" is not a gRPC address. Write host:port.`);
  return { host: match[1]!, port: match[2] ? Number(match[2]) : 443 };
}

function socketOnly(where: string): never {
  throw refusal({ message: `A gRPC call carries credentials in its metadata or on the connection, not at ${where}.`, code: 'refusal.auth_place_unsupported' });
}

function surface(wire: GrpcWire, socket: SocketAuth): AuthSurface {
  return {
    setHeader: (name, value) => {
      wire.metadata[name.toLowerCase()] = value;
    },
    setQuery: (n) => socketOnly(`query:${n}`),
    setBodyPath: (p) => socketOnly(`body:${p}`),
    setCookie: (n) => socketOnly(`cookie:${n}`),
    setForm: (n) => socketOnly(`form:${n}`),
    setSoapHeader: (p) => socketOnly(`soap:${p}`),
    socket,
  };
}

/* ── Reaching the server ────────────────────────────────────────────────── */

async function clientFor(wire: GrpcWire, socket: SocketAuth, inAgent: boolean, maxBytes: number): Promise<grpc.Client> {
  if (wire.plaintext && !inAgent) {
    throw refusal({ message: 'An unencrypted gRPC server is only reached through the Silo agent.', code: 'refusal.plaintext' });
  }
  if (socket.tls.fingerprint) {
    throw refusal({
      message: 'A gRPC server is trusted by its certificate authority, not a pinned fingerprint. Give the connection the CA certificate instead.',
      code: 'refusal.tls_pin_unsupported',
    });
  }
  /* The address checked is the address connected to: resolve once, connect to that, verify the name. */
  let target = wire.host;
  if (!inAgent) {
    try {
      const [first] = await resolveGuarded(wire.host);
      target = first!.family === 6 ? `[${first!.address}]` : first!.address;
    } catch (error) {
      if (error instanceof BlockedAddress) {
        throw refusal({ message: `${wire.host} is a private address. Reach it through the Silo agent.`, code: 'refusal.blocked_host', detail: { host: wire.host } });
      }
      throw upstream({ message: `${wire.host} could not be resolved.`, code: 'upstream.unreachable', cause: error });
    }
  }
  const tls = socket.tls;
  const credentials = wire.plaintext
    ? grpc.credentials.createInsecure()
    : grpc.credentials.createSsl(
        tls.ca && !tls.systemTrust ? Buffer.from(tls.ca) : null,
        tls.key ? Buffer.from(tls.key) : null,
        tls.cert ? Buffer.from(tls.cert) : null,
      );
  const name = tls.servername ?? wire.host;
  return new grpc.Client(`${target}:${wire.port}`, credentials, {
    'grpc.ssl_target_name_override': name,
    'grpc.default_authority': name,
    'grpc.max_receive_message_length': Math.max(1, Math.min(maxBytes, 2 ** 31 - 1)),
    'grpc.enable_retries': 0,
  });
}

function metadataOf(values: Record<string, string>): grpc.Metadata {
  const metadata = new grpc.Metadata();
  for (const [name, value] of Object.entries(values)) {
    if (name.endsWith('-bin')) metadata.set(name, Buffer.from(value, 'base64'));
    else metadata.set(name, value);
  }
  return metadata;
}

const deadline = (timeoutMs: number) => new Date(Date.now() + timeoutMs);

/* ── Reflection ─────────────────────────────────────────────────────────── */

/** The reflection protocol itself — the one schema a client needs before it can ask for any other. */
const REFLECTION = protobuf.Root.fromJSON({
  nested: {
    reflection: {
      nested: {
        ServerReflectionRequest: {
          oneofs: { messageRequest: { oneof: ['fileByFilename', 'fileContainingSymbol', 'listServices'] } },
          fields: {
            host: { type: 'string', id: 1 },
            fileByFilename: { type: 'string', id: 3 },
            fileContainingSymbol: { type: 'string', id: 4 },
            listServices: { type: 'string', id: 7 },
          },
        },
        ServerReflectionResponse: {
          oneofs: { messageResponse: { oneof: ['fileDescriptorResponse', 'listServicesResponse', 'errorResponse'] } },
          fields: {
            validHost: { type: 'string', id: 1 },
            fileDescriptorResponse: { type: 'FileDescriptorResponse', id: 4 },
            listServicesResponse: { type: 'ListServiceResponse', id: 6 },
            errorResponse: { type: 'ErrorResponse', id: 7 },
          },
        },
        FileDescriptorResponse: { fields: { fileDescriptorProto: { rule: 'repeated', type: 'bytes', id: 1 } } },
        ListServiceResponse: { fields: { service: { rule: 'repeated', type: 'ServiceResponse', id: 1 } } },
        ServiceResponse: { fields: { name: { type: 'string', id: 1 } } },
        ErrorResponse: { fields: { errorCode: { type: 'int32', id: 1 }, errorMessage: { type: 'string', id: 2 } } },
      },
    },
  },
});
const ReflectionRequest = REFLECTION.lookupType('reflection.ServerReflectionRequest');
const ReflectionResponse = REFLECTION.lookupType('reflection.ServerReflectionResponse');

interface ReflectionAnswer {
  fileDescriptorResponse?: { fileDescriptorProto: Uint8Array[] };
  listServicesResponse?: { service: Array<{ name: string }> };
  errorResponse?: { errorCode: number; errorMessage: string };
}

/** One reflection conversation: ask each question in turn on one stream. */
async function reflect(client: grpc.Client, metadata: grpc.Metadata, timeoutMs: number, questions: Array<Record<string, string>>, version: 'v1' | 'v1alpha'): Promise<ReflectionAnswer[]> {
  const call = client.makeBidiStreamRequest(
    `/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`,
    (value: Record<string, string>) => Buffer.from(ReflectionRequest.encode(ReflectionRequest.fromObject(value)).finish()),
    (bytes: Buffer) => ReflectionResponse.toObject(ReflectionResponse.decode(bytes), { defaults: false }) as ReflectionAnswer,
    metadata,
    { deadline: deadline(timeoutMs) },
  );
  const answers: ReflectionAnswer[] = [];
  return new Promise((resolve, reject) => {
    call.on('data', (answer: ReflectionAnswer) => {
      answers.push(answer);
      if (answers.length === questions.length) call.end();
    });
    call.on('error', reject);
    call.on('end', () => resolve(answers));
    for (const question of questions) call.write(question);
  });
}

/** Every file the service's definition needs, asked for until nothing is missing. */
async function filesFor(client: grpc.Client, metadata: grpc.Metadata, service: string, timeoutMs: number): Promise<Uint8Array[]> {
  let version: 'v1' | 'v1alpha' = 'v1';
  const ask = async (questions: Array<Record<string, string>>) => {
    try {
      return await reflect(client, metadata, timeoutMs, questions, version);
    } catch (error) {
      if ((error as { code?: number }).code === grpc.status.UNIMPLEMENTED && version === 'v1') {
        version = 'v1alpha';
        return reflect(client, metadata, timeoutMs, questions, version);
      }
      throw error;
    }
  };
  const files = new Map<string, Uint8Array>();
  const take = (answers: ReflectionAnswer[]) => {
    for (const answer of answers) {
      if (answer.errorResponse) throw Object.assign(new Error(answer.errorResponse.errorMessage), { code: answer.errorResponse.errorCode });
      for (const bytes of answer.fileDescriptorResponse?.fileDescriptorProto ?? []) {
        const file = protobufDescriptorName(bytes);
        if (!files.has(file.name)) files.set(file.name, bytes);
      }
    }
  };
  take(await ask([{ fileContainingSymbol: service }]));
  for (let round = 0; round < 8; round++) {
    const missing = new Set<string>();
    for (const bytes of files.values()) for (const dep of protobufDescriptorName(bytes).dependency) if (!files.has(dep)) missing.add(dep);
    if (missing.size === 0) break;
    take(await ask([...missing].map((fileByFilename) => ({ fileByFilename }))));
  }
  return [...files.values()];
}

/** A serialised FileDescriptorProto's name and dependencies, without building a root. */
function protobufDescriptorName(bytes: Uint8Array): { name: string; dependency: string[] } {
  const reader = protobuf.Reader.create(bytes);
  let name = '';
  const dependency: string[] = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field === 1) name = reader.string();
    else if (field === 3) dependency.push(reader.string());
    else reader.skipType(tag & 7);
  }
  return { name, dependency };
}

/* ── Calling ────────────────────────────────────────────────────────────── */

function methodOf(root: protobuf.Root, service: string, rpc: string): protobuf.Method {
  let svc: protobuf.Service;
  try {
    svc = root.lookupService(service);
  } catch {
    throw refusal({ message: `The server's definition has no service called ${service}.`, code: 'refusal.request_unbuildable' });
  }
  const method = svc.methods[rpc];
  if (!method) throw refusal({ message: `${service} has no method called ${rpc}.`, code: 'refusal.request_unbuildable' });
  if (method.requestStream) {
    throw refusal({ message: `${service}.${rpc} takes a stream of requests, which is not a read.`, code: 'refusal.request_unbuildable' });
  }
  return method.resolve() as protobuf.Method;
}

function ok(body: unknown, started: number): WireResponse {
  return { status: null, code: null, message: null, headers: {}, body: Buffer.from(JSON.stringify(body)), contentType: WIRE_CONTENT_TYPE, durationMs: Date.now() - started };
}

function failed(error: unknown, started: number): WireResponse {
  const e = error as { code?: number; details?: string; message?: string };
  const code = typeof e?.code === 'number' ? (grpc.status[e.code] ?? 'UNKNOWN') : 'UNKNOWN';
  return { status: null, code, message: (e?.details || e?.message || '').slice(0, 500), headers: {}, body: Buffer.alloc(0), contentType: null, durationMs: Date.now() - started };
}

async function call(client: grpc.Client, wire: GrpcWire, method: protobuf.Method, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const requestType = method.resolvedRequestType!;
  const responseType = method.resolvedResponseType!;
  const path = `/${wire.service}/${wire.rpc}`;
  let argument: Uint8Array;
  try {
    argument = encode(requestType, wire.message);
  } catch (error) {
    if (error instanceof FormatError) unbuildable(error.message);
    throw error;
  }
  const serialize = (bytes: Uint8Array) => Buffer.from(bytes);
  const deserialize = (bytes: Buffer) => plainOf(responseType, responseType.decode(bytes));
  const metadata = metadataOf(wire.metadata);

  if (!method.responseStream) {
    return new Promise((resolve, reject) => {
      client.makeUnaryRequest(path, serialize, deserialize, argument, metadata, { deadline: deadline(timeoutMs) }, (error, value) => (error ? reject(error) : resolve(value)));
    });
  }
  const stream = client.makeServerStreamRequest(path, serialize, deserialize, argument, metadata, { deadline: deadline(timeoutMs) });
  const out: unknown[] = [];
  let bytes = 0;
  return new Promise((resolve, reject) => {
    stream.on('data', (one: unknown) => {
      out.push(one);
      bytes += JSON.stringify(one).length;
      if (bytes > maxBytes || out.length > MAX_STREAMED) {
        stream.cancel();
        reject(bounds({ message: `${wire.service}.${wire.rpc} streamed more than one question may read. Ask it for less.`, code: 'bounds.bytes', detail: { limit: maxBytes } }));
      }
    });
    stream.on('error', (error: { code?: number }) => (error.code === grpc.status.CANCELLED && (bytes > maxBytes || out.length > MAX_STREAMED) ? undefined : reject(error)));
    stream.on('end', () => resolve(out));
  });
}

export const grpcTransport: Transport<GrpcWire> = {
  kind: 'grpc',
  writes: true,
  answersWire: true,

  prepare({ transport, request }) {
    const t = transport as Extract<TransportV2, { kind: 'grpc' }>;
    const { host, port } = addressOf(str(request.connection.address));
    if (!request.service || !request.rpc) unbuildable('A gRPC read names its service and method.');
    if (!t.descriptor && !t.reflection) unbuildable('A gRPC connector needs a descriptor set, or reflection turned on for a server that offers it.');
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...t.metadata, ...request.headers })) metadata[name.toLowerCase()] = String(value);
    return {
      kind: 'grpc',
      host,
      port,
      plaintext: t.security === 'none',
      service: request.service,
      rpc: request.rpc,
      message: request.body ?? {},
      metadata,
      descriptor: t.descriptor ?? null,
      reflection: t.reflection,
    };
  },

  authSurface: (wire, socket) => surface(wire, socket),

  async send(wire, options) {
    const started = Date.now();
    const client = await clientFor(wire, options.socket, options.inAgent === true, options.maxBytes);
    try {
      const root = wire.descriptor ? rootOf(wire.descriptor) : rootOf(await filesFor(client, metadataOf(wire.metadata), wire.service, options.timeoutMs));
      const method = methodOf(root, wire.service, wire.rpc);
      for (let attempt = 0; ; attempt++) {
        try {
          return ok(await call(client, wire, method, options.timeoutMs, options.maxBytes), started);
        } catch (error) {
          /* UNAVAILABLE is the transport's own "try again"; a read tries once more, a write never. */
          if (options.retry && attempt === 0 && (error as { code?: number }).code === grpc.status.UNAVAILABLE) continue;
          throw error;
        }
      }
    } catch (error) {
      if (isAppError(error)) throw error;
      return failed(error, started);
    } finally {
      client.close();
    }
  },

  floor(res) {
    if (res.code === null) return null;
    switch (res.code) {
      case 'UNAUTHENTICATED':
      case 'PERMISSION_DENIED':
        return { means: 'auth' };
      case 'NOT_FOUND':
        return { means: 'not_found' };
      case 'RESOURCE_EXHAUSTED':
        return { means: 'rate_limit' };
      case 'DEADLINE_EXCEEDED':
        return { means: 'bounds' };
      default:
        return { means: 'upstream' };
    }
  },

  /** The services and methods a server offers, as objects whose fields are the answer's. Never a row. */
  async describe(wire, options) {
    const client = await clientFor(wire, options.socket, options.inAgent === true, options.maxBytes);
    try {
      const root = wire.descriptor ? rootOf(wire.descriptor) : rootOf(await filesFor(client, metadataOf(wire.metadata), wire.service, options.timeoutMs));
      const objects: Structure['objects'] = [];
      root.resolveAll();
      const visit = (ns: protobuf.NamespaceBase) => {
        for (const nested of ns.nestedArray) {
          if (nested instanceof protobuf.Service) {
            for (const method of nested.methodsArray) {
              if (method.requestStream) continue;
              const type = method.resolvedResponseType!;
              objects.push({
                name: `${nested.fullName.replace(/^\./, '')}.${method.name}`,
                fields: type.fieldsArray.map((f) => ({ name: f.name, type: f.repeated ? 'json' : f.type, nullable: true })),
                identifier: [],
                relationships: [],
              });
            }
          } else if (nested instanceof protobuf.Namespace) visit(nested);
        }
      };
      visit(root);
      return { objects };
    } finally {
      client.close();
    }
  },
};
