import protobuf from 'protobufjs';
import descriptor from 'protobufjs/ext/descriptor';
import { checkNodes, FormatError, type FormatParser } from './contract.format';

/**
 * Protocol Buffers: a body, or a gRPC message, read against a descriptor.
 *
 * A PROTOBUF MESSAGE HAS NO NAMES IN IT. Field 3 is field 3; what it is called
 * comes from the descriptor set the system publishes (`protoc
 * --descriptor_set_out`), or from the server itself over gRPC reflection. The
 * values come out as the proto3 JSON mapping says: 64-bit integers as text,
 * enums by name, bytes as base64, a Timestamp as ISO 8601, a wrapper as its
 * value — so an expression reads a gRPC answer the way it reads a REST one.
 */

type Root = protobuf.Root;

const fromDescriptor = (set: unknown): Root =>
  (protobuf.Root as unknown as { fromDescriptor(set: unknown): Root }).fromDescriptor(set);

/** A root from a base64 `FileDescriptorSet`, or from the serialised `FileDescriptorProto`s reflection returns. */
export function rootOf(source: string | Uint8Array[]): Root {
  if (typeof source === 'string') return fromDescriptor(descriptor.FileDescriptorSet.decode(Buffer.from(source, 'base64')));
  const files = source.map((bytes) => descriptor.FileDescriptorProto.decode(bytes));
  return fromDescriptor(descriptor.FileDescriptorSet.create({ file: files }));
}

const WRAPPERS = new Set([
  'google.protobuf.DoubleValue', 'google.protobuf.FloatValue', 'google.protobuf.Int64Value', 'google.protobuf.UInt64Value',
  'google.protobuf.Int32Value', 'google.protobuf.UInt32Value', 'google.protobuf.BoolValue', 'google.protobuf.StringValue',
  'google.protobuf.BytesValue',
]);

const nameOf = (type: protobuf.Type): string => type.fullName.replace(/^\./, '');

/** The proto3 JSON mapping for the well-known types, applied to what `toObject` produced. */
function mapped(type: protobuf.Type, value: unknown, depth: number): unknown {
  if (value === null || value === undefined || depth > 32) return value;
  const name = nameOf(type);
  if (name === 'google.protobuf.Timestamp') {
    const v = value as { seconds?: string | number; nanos?: number };
    const ms = Number(v.seconds ?? 0) * 1000 + Math.floor((v.nanos ?? 0) / 1e6);
    return new Date(ms).toISOString();
  }
  if (name === 'google.protobuf.Duration') {
    const v = value as { seconds?: string | number; nanos?: number };
    return `${Number(v.seconds ?? 0) + (v.nanos ?? 0) / 1e9}s`;
  }
  if (WRAPPERS.has(name)) return (value as { value?: unknown }).value ?? null;
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of type.fieldsArray) {
    const resolved = field.resolve().resolvedType;
    if (!(resolved instanceof protobuf.Type) || out[field.name] === undefined) continue;
    const one = out[field.name];
    if (field.map && one && typeof one === 'object') {
      out[field.name] = Object.fromEntries(Object.entries(one as Record<string, unknown>).map(([k, v]) => [k, mapped(resolved, v, depth + 1)]));
    } else if (field.repeated && Array.isArray(one)) {
      out[field.name] = one.map((v) => mapped(resolved, v, depth + 1));
    } else {
      out[field.name] = mapped(resolved, one, depth + 1);
    }
  }
  return out;
}

const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * The inverse, for a request: ISO 8601 into a Timestamp, a plain value into its
 * wrapper. A key may be the field's name or its proto3 JSON name
 * (`page_size` or `pageSize`); anything else is refused, because protobufjs
 * would drop it silently and the server would answer a different question.
 */
function unmapped(type: protobuf.Type, value: unknown, depth: number, at: string): unknown {
  if (value === null || value === undefined || depth > 32) return value;
  const name = nameOf(type);
  if (name === 'google.protobuf.Timestamp' && typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new FormatError('protobuf', `${at} is "${value.slice(0, 40)}", which is not a timestamp.`);
    return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
  }
  if (name === 'google.protobuf.Duration' && typeof value === 'string') {
    const seconds = Number(value.replace(/s$/, ''));
    return { seconds: Math.trunc(seconds), nanos: Math.round((seconds % 1) * 1e9) };
  }
  if (WRAPPERS.has(name) && (typeof value !== 'object' || value === null)) return { value };
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const byName = new Map<string, protobuf.Field>();
  for (const field of type.fieldsArray) {
    byName.set(field.name, field);
    byName.set(camel(field.name), field);
  }
  const out: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
    const field = byName.get(key);
    if (!field) throw new FormatError('protobuf', `${name} has no field called ${key}${at ? ` (at ${at})` : ''}.`);
    const resolved = field.resolve().resolvedType;
    const path = at ? `${at}.${field.name}` : field.name;
    out[field.name] =
      resolved instanceof protobuf.Type
        ? field.repeated && Array.isArray(one)
          ? one.map((v, i) => unmapped(resolved, v, depth + 1, `${path}[${i}]`))
          : unmapped(resolved, one, depth + 1, path)
        : one;
  }
  return out;
}

/** A decoded message as the value expressions read. */
export function plainOf(type: protobuf.Type, message: protobuf.Message): unknown {
  const object = type.toObject(message, { longs: String, enums: String, bytes: String, defaults: true, arrays: true, objects: true, oneofs: true });
  return mapped(type, object, 0);
}

/** A request value, as the document wrote it, encoded as `type`. Unknown fields are refused, not dropped. */
export function encode(type: protobuf.Type, value: unknown): Uint8Array {
  const object = unmapped(type, value ?? {}, 0, '') as Record<string, unknown>;
  const problem = type.verify(object);
  if (problem) throw new FormatError('protobuf', `The request is not a ${nameOf(type)}: ${problem}.`);
  return type.encode(type.fromObject(object)).finish();
}

export const protobufFormat: FormatParser = {
  name: 'protobuf',
  contentTypes: ['application/x-protobuf', 'application/protobuf', 'application/vnd.google.protobuf'],
  binary: true,
  parse({ input, options }) {
    if (!options.descriptor || !options.message) {
      throw new FormatError('protobuf', 'A Protocol Buffers body is read against a descriptor and a message name, and this connector declares neither.');
    }
    let type: protobuf.Type;
    try {
      type = rootOf(options.descriptor).lookupType(options.message);
    } catch (error) {
      throw new FormatError('protobuf', `The descriptor could not be read, or has no message ${options.message}: ${error instanceof Error ? error.message : ''}`);
    }
    try {
      const value = plainOf(type, type.decode(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'latin1')));
      checkNodes('protobuf', value);
      return value;
    } catch (error) {
      throw new FormatError('protobuf', `The body is not a ${options.message}: ${error instanceof Error ? error.message : 'unreadable'}.`);
    }
  },
};
