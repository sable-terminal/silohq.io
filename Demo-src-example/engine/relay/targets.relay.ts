import { isIP } from 'node:net';
import type { TransportKindV2 } from '../../schemas/manifest.schema';
import type { WireRequest } from '../transports/contract.transport';
import type { AllowedHost } from './frame.relay';

/**
 * Where a job would connect, and whether it may.
 *
 * ── READ FROM THE WIRE, AFTER EVERYTHING HAS RUN ──────────────────────────
 *
 * A manifest says `via: { agent: true }` and nothing about addresses; the host
 * is `baseUrl` over params, or a database host, or brokers. What is checked is
 * the wire request as it will be sent — the resolved URL, the host the driver
 * will open — by Silo before a job is dispatched and again by the agent before
 * it runs, each against its own list.
 */

export interface Target {
  host: string;
  port: number;
}

const DEFAULT_PORTS: Partial<Record<TransportKindV2, number>> = {
  sftp: 22,
  ftp: 21,
  smb: 445,
  imap: 993,
  grpc: 443,
  kafka: 9092,
};

function hostPort(value: string, fallback: number): Target {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1]!.toLowerCase(), port: bracketed[2] ? Number(bracketed[2]) : fallback };
  const at = value.lastIndexOf(':');
  if (at > 0 && isIP(value) !== 6 && /^\d+$/.test(value.slice(at + 1))) return { host: value.slice(0, at).toLowerCase(), port: Number(value.slice(at + 1)) };
  return { host: value.toLowerCase(), port: fallback };
}

/** Every host and port a wire request would open. An unknown shape names nothing, and nothing is permitted. */
export function targetsOf(kind: TransportKindV2 | 'http', wire: WireRequest | object): Target[] {
  const w = wire as unknown as Record<string, unknown>;
  if (kind === 'https_rest' || kind === 'graphql' || kind === 'soap' || kind === 'http') {
    const url = new URL(typeof w.url === 'string' ? w.url : `${String(w.base)}${w.rawQuery ? `?${String(w.rawQuery)}` : ''}`);
    return [{ host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443 }];
  }
  if (kind === 'sql') {
    const c = (w.connection ?? {}) as Record<string, unknown>;
    const defaults: Record<string, number> = { pg: 5432, mysql2: 3306, mssql: 1433, oracledb: 1521 };
    const fallback = defaults[String(c.driver)] ?? 0;
    if (typeof c.host === 'string' && c.host) return [{ host: c.host.toLowerCase(), port: Number(c.port ?? fallback) }];
    /* An Oracle descriptor names its own addresses — every one of a RAC's is a target. */
    if (typeof c.connectString === 'string') {
      const described = [...c.connectString.matchAll(/\(\s*HOST\s*=\s*([^)\s]+)\s*\)\s*\(\s*PORT\s*=\s*(\d+)\s*\)/gi)].map((m) => ({ host: m[1]!.toLowerCase(), port: Number(m[2]) }));
      if (described.length > 0) return described;
      const easy = /^(?:\/\/)?([^:/]+)(?::(\d+))?/.exec(c.connectString.trim());
      if (easy) return [{ host: easy[1]!.toLowerCase(), port: easy[2] ? Number(easy[2]) : fallback }];
    }
    return [];
  }
  if (kind === 'kafka') return ((w.brokers as string[] | undefined) ?? []).map((b) => hostPort(b, 9092));
  if (typeof w.host === 'string' && w.host) return [{ host: w.host.toLowerCase(), port: Number(w.port ?? DEFAULT_PORTS[kind as TransportKindV2] ?? 0) }];
  return [];
}

/** Whether one host matches one entry: exactly, or beneath a `*.` pattern. */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

export function permitted(target: Target, list: ReadonlyArray<Pick<AllowedHost, 'host' | 'portFrom' | 'portTo'>>): boolean {
  return list.some((entry) => hostMatches(entry.host, target.host) && target.port >= entry.portFrom && target.port <= entry.portTo);
}

/**
 * Addresses no list can open: loopback, link-local (which is where every cloud
 * keeps its metadata service), and the unspecified address. An agent sits on a
 * customer's machine; reaching that machine's own services, or its cloud's
 * instance credentials, is never what a connection is for.
 */
export function alwaysRefused(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (a === '0.0.0.0' || a === '::' || a === '::1' || a === 'localhost') return true;
  if (/^127\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;
  if (a === 'fd00:ec2::254' || a === 'metadata.google.internal' || a === 'metadata') return true;
  return false;
}
