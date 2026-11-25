// Outbound HTTP from the cell to customer systems: connector requests placed by the
// credential service, OAuth token exchanges, and unauthenticated reads.
//
// - Public addresses only. The address a name resolves to is checked at connect time, in
//   the socket's own lookup, so a name that resolves to a private, loopback, link-local or
//   metadata address is refused even if it changes between checks. Systems behind a
//   firewall are reached through the Silo Agent. Development and tests may allow private
//   addresses for local fakes (CONNECT_EGRESS_ALLOW_PRIVATE).
// - The exception: a request may carry its organisation's private links (the ranges its
//   VPC-to-VPC link brings into the cell), and then reaches a private address inside one
//   of them. The cell's own networks (CONNECT_CELL_NETWORKS) are never reached, whatever a
//   link says, and neither is anything outside private space (loopback, link-local,
//   metadata), which no link may hold.
// - HTTPS only, at TLS 1.2 or above, unless development allows http.
// - Redirects are not followed: a 3xx is returned as it came, so a redirect can never
//   carry a placed secret to another host.
// - Bounded: a timeout for the whole exchange, and a response over its byte limit is
//   refused, never truncated.
// Errors are AppErrors without the remote's text (it may quote values): unreachable,
// timeout, or the bound.
//
// TCP for SSH (SFTP, spec 14.4) under the same address rules (createTcpEgress): the name is
// resolved in the socket's own lookup and refused where it is private outside a link or
// one of the cell's networks.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net';
import type { ConnectConfig } from '../config/connect.config.ts';
import type * as oidc from 'openid-client';
import { AppError } from '../utils/errors.util.ts';
import { cidrContains, isPrivateLinkRange, parseCidr, type Cidr } from '../utils/network.util.ts';

export interface EgressRequest {
  url: URL;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: string | Buffer | undefined;
  timeoutMs?: number | undefined;
  minTlsVersion?: '1.2' | '1.3' | undefined;
  signal?: AbortSignal | undefined;
  /** The ranges of the requesting organisation's live private links, in CIDR notation. */
  privateLinks?: readonly string[] | undefined;
}

export interface EgressResult {
  status: number;
  /** Lower-cased names; repeated headers joined with ", " (set-cookie kept apart). */
  headers: Record<string, string>;
  setCookies: string[];
  body: Buffer;
}

export interface Egress {
  send(request: EgressRequest): Promise<EgressResult>;
}

// Addresses the cell must never reach from a manifest (RFC 6890 special purpose, plus the
// cloud metadata range).
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

class EgressRefused extends Error {}

/**
 * Whether the egress may reach the address: a public one, or a private one inside one of
 * the organisation's links; never one of the cell's own networks.
 */
export function reachable(address: string, links: readonly Cidr[], cellNetworks: readonly Cidr[], allowPrivate = false): boolean {
  if (cellNetworks.some((network) => cidrContains(network, address))) return false;
  if (allowPrivate || !isPrivateAddress(address)) return true;
  return links.some((link) => cidrContains(link, address));
}

const PRIVATE_REFUSAL = 'the cell does not reach private addresses outside a private link; use the Silo Agent';

export function createEgress(config: Pick<ConnectConfig, 'egressAllowPrivate' | 'egressAllowHttp' | 'egressTimeoutMs' | 'egressMaxResponseBytes'
  | 'cellNetworks'>): Egress {
  const cellNetworks = (config.cellNetworks ?? []).map((text) => parseCidr(text)!);
  // A link is honoured only if it lies in private space, whatever the caller passed.
  const linksOf = (request: EgressRequest): Cidr[] => (request.privateLinks ?? [])
    .map((text) => parseCidr(text)).filter((link): link is Cidr => link !== undefined && isPrivateLinkRange(link));
  const lookupFor = (links: readonly Cidr[]): LookupFunction => (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as unknown as LookupAddress[];
      const usable = list.filter((a) => reachable(a.address, links, cellNetworks, config.egressAllowPrivate));
      if (usable.length === 0) return callback(new EgressRefused('private address'), '', 0);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
      return callback(null, usable[0]!.address, usable[0]!.family);
    });
  };

  return {
    send(request) {
      const { url } = request;
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.egressAllowHttp)) {
        return Promise.reject(new AppError('validation', 'customer systems are reached over HTTPS', { code: 'egress.https_required' }));
      }
      if (url.username !== '' || url.password !== '') {
        return Promise.reject(new AppError('validation', 'a URL never carries credentials', { code: 'egress.url_credentials' }));
      }
      const links = linksOf(request);
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(literal) !== 0 && !reachable(literal, links, cellNetworks, config.egressAllowPrivate)) {
        return Promise.reject(new AppError('forbidden', PRIVATE_REFUSAL, { code: 'egress.private_address' }));
      }
      const timeoutMs = Math.min(request.timeoutMs ?? config.egressTimeoutMs, config.egressTimeoutMs);
      const limit = config.egressMaxResponseBytes;
      const transport = url.protocol === 'https:' ? https : http;

      return new Promise<EgressResult>((resolve, reject) => {
        let settled = false;
        const fail = (error: AppError) => {
          if (settled) return;
          settled = true;
          req.destroy();
          reject(error);
        };
        const req = transport.request(url, {
          method: request.method,
          headers: { ...request.headers, ...(request.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(request.body)) }) },
          lookup: lookupFor(links),
          ...(url.protocol === 'https:' ? { minVersion: request.minTlsVersion === '1.3' ? 'TLSv1.3' as const : 'TLSv1.2' as const } : {}),
          signal: request.signal,
        }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              fail(new AppError('bounds', 'the response is larger than the bound; refused rather than truncated', {
                code: 'egress.response_too_large', details: { bound: 'egress_response_bytes', limit },
              }));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              if (name === 'set-cookie' || value === undefined) continue;
              headers[name] = Array.isArray(value) ? value.join(', ') : value;
            }
            resolve({ status: res.statusCode ?? 0, headers, setCookies: res.headers['set-cookie'] ?? [], body: Buffer.concat(chunks) });
          });
          res.on('error', () => fail(new AppError('source_unreachable', 'the connection to the source was lost', { code: 'egress.unreachable' })));
        });
        const timer = setTimeout(() => fail(new AppError('timeout', 'the source did not answer in time', {
          code: 'egress.timeout', details: { timeoutMs },
        })), timeoutMs);
        req.on('error', (error) => {
          clearTimeout(timer);
          if (error instanceof EgressRefused || (error as { cause?: unknown }).cause instanceof EgressRefused) {
            fail(new AppError('forbidden', PRIVATE_REFUSAL, { code: 'egress.private_address' }));
          } else if (request.signal?.aborted) {
            fail(new AppError('timeout', 'the request was abandoned', { code: 'egress.aborted' }));
          } else {
            fail(new AppError('source_unreachable', 'the source could not be reached', { code: 'egress.unreachable', retryable: true }));
          }
        });
        if (request.body !== undefined) req.write(request.body);
        req.end();
      });
    },
  };
}

/** The fetch openid-client calls, through the cell's egress: customer SSO (credential) and the staff provider (admin-portal). */
export function oidcFetch(egress: Egress): oidc.CustomFetch {
  return async (url, options) => {
    const headers: Record<string, string> = { ...options.headers };
    const raw = options.body;
    const body = raw === undefined || raw === null ? undefined
      : typeof raw === 'string' ? raw
        : raw instanceof URLSearchParams ? raw.toString()
          : raw instanceof Uint8Array ? Buffer.from(raw)
            : raw instanceof ArrayBuffer ? Buffer.from(raw) : undefined;
    const method = (options.method ?? 'GET').toUpperCase() as EgressRequest['method'];
    const result = await egress.send({ url: new URL(url), method, headers, body, signal: options.signal ?? undefined });
    const nullBody = result.status === 204 || result.status === 304;
    return new Response(nullBody ? null : new Uint8Array(result.body), { status: result.status, headers: result.headers });
  };
}

export interface TcpEgress {
  /** A TCP socket to a customer system, connected under the egress's address rules. */
  connect(request: { host: string; port: number; timeoutMs?: number | undefined; privateLinks?: readonly string[] | undefined }): Promise<Socket>;
}

/** TCP for SSH (SFTP): the same address rules as HTTPS, the address checked in the socket's own lookup. */
export function createTcpEgress(config: Pick<ConnectConfig, 'egressAllowPrivate' | 'egressTimeoutMs' | 'cellNetworks'>): TcpEgress {
  const cellNetworks = (config.cellNetworks ?? []).map((text) => parseCidr(text)!);
  return {
    connect(request) {
      const links = (request.privateLinks ?? []).map((text) => parseCidr(text)).filter((link): link is Cidr => link !== undefined && isPrivateLinkRange(link));
      const literal = request.host.replace(/^\[|\]$/g, '');
      if (isIP(literal) !== 0 && !reachable(literal, links, cellNetworks, config.egressAllowPrivate)) {
        return Promise.reject(new AppError('forbidden', PRIVATE_REFUSAL, { code: 'egress.private_address' }));
      }
      const lookup: LookupFunction = (hostname, options, callback) => {
        dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) return callback(error, '', 0);
          const usable = (addresses as unknown as LookupAddress[]).filter((a) => reachable(a.address, links, cellNetworks, config.egressAllowPrivate));
          if (usable.length === 0) return callback(new EgressRefused('private address'), '', 0);
          if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
          return callback(null, usable[0]!.address, usable[0]!.family);
        });
      };
      const timeoutMs = Math.min(request.timeoutMs ?? config.egressTimeoutMs, config.egressTimeoutMs);
      return new Promise<Socket>((resolve, reject) => {
        const socket = netConnect({ host: literal, port: request.port, lookup, timeout: timeoutMs });
        const fail = (error: AppError) => {
          socket.destroy();
          reject(error);
        };
        socket.once('connect', () => {
          socket.setTimeout(0);
          socket.removeAllListeners('error');
          resolve(socket);
        });
        socket.once('timeout', () => fail(new AppError('upstream', 'the system did not answer in time', { code: 'egress.timeout', retryable: true })));
        socket.once('error', (error) => fail(error instanceof EgressRefused
          ? new AppError('forbidden', PRIVATE_REFUSAL, { code: 'egress.private_address' })
          : new AppError('upstream', 'the system could not be reached', { code: 'egress.unreachable', retryable: true })));
      });
    },
  };
}
