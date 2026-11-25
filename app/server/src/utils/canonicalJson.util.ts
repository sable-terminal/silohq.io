// Canonical JSON (RFC 8785, JSON Canonicalization Scheme): one byte sequence per value,
// so a hash over it is stable across services and releases. Used for manifest and
// document hashes, the audit chain, and the associated data of sealed secrets.
//
// Object keys are sorted by UTF-16 code unit; there is no whitespace; numbers use the
// ECMAScript form (JSON.stringify). A property whose value is undefined is omitted, as
// JSON.stringify omits it. Anything that is not JSON (undefined in an array, a function,
// a bigint, NaN, a Date, a Buffer, a class instance) is refused rather than guessed:
// convert it first (a timestamp to canonicalTimestamp, bytes to base64).

export function canonicalJson(value: unknown): string {
  return serialise(value, '$');
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function serialise(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical JSON: ${path} is not a finite number`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => {
          if (item === undefined) throw new TypeError(`canonical JSON: ${path}[${i}] is undefined`);
          return serialise(item, `${path}[${i}]`);
        }).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`canonical JSON: ${path} is a ${prototype?.constructor?.name ?? 'non-plain'} object`);
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialise(record[key], `${path}.${key}`)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON: ${path} is a ${typeof value}`);
  }
}
