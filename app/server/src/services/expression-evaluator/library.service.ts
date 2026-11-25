// The fixed library of pure functions an expression may call (spec 14.2): hashes, HMAC,
// encodings, canonical query strings, time formats and link header parsing. No network,
// file, environment, clock or randomness. Additions are Silo releases.

import { createHash, createHmac } from 'node:crypto';

const bytesOf = (value: string | Uint8Array): Buffer => (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));

export function sha256(value: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytesOf(value)).digest());
}

export function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', bytesOf(key)).update(bytesOf(message)).digest());
}

export const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
export const base64 = (value: Uint8Array): string => Buffer.from(value).toString('base64');
export const base64url = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

export function base64Decode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new RangeError('not base64');
  return new Uint8Array(Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
}

/** RFC 3986 percent-encoding: everything but unreserved characters. */
export const urlEncode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const scalarText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  throw new TypeError('a query value is a scalar');
};

/** Keys sorted by code point, keys and values RFC 3986 encoded, joined key=value&... */
export function canonicalQuery(query: Record<string, unknown> | Map<unknown, unknown>): string {
  const entries = query instanceof Map ? [...query.entries()].map(([k, v]) => [String(k), v] as const) : Object.entries(query);
  return entries
    .map(([key, value]) => [urlEncode(key), urlEncode(scalarText(value))] as const)
    .sort(([a, va], [b, vb]) => (a < b ? -1 : a > b ? 1 : va < vb ? -1 : va > vb ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .reduce((all, pair) => (all === '' ? pair : `${all}&${pair}`), '');
}

export const epochSeconds = (at: Date): bigint => BigInt(Math.floor(at.getTime() / 1000));
export const epochMillis = (at: Date): bigint => BigInt(at.getTime());
export const rfc3339 = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** RFC 7231 IMF-fixdate, as HTTP Date headers carry it. */
export const httpDate = (at: Date): string => at.toUTCString();

/** RFC 8288 Link header: each rel to its URL. Unparseable parts are ignored. */
export function parseLinkHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.slice(0, 16_384).split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!match) continue;
    const rel = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(match[2]!)?.[1];
    if (rel === undefined) continue;
    for (const name of rel.trim().split(/\s+/)) out[name.toLowerCase()] ??= match[1]!;
  }
  return out;
}

/** The path of an absolute or relative URL, for paging by a link the source returns. */
export function urlPath(text: string): string {
  return new URL(text, 'https://relative.invalid').pathname;
}

/** The query parameters of a URL, each name to its first value. */
export function urlQuery(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(text, 'https://relative.invalid').searchParams) out[k] ??= v;
  return out;
}
