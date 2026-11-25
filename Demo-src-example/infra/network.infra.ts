import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Agent, buildConnector, Client, request as undiciRequest, type Dispatcher } from 'undici';
import { isBlockedHost } from '../utils/blockedHost.util';
import { nextDelay, parseRetryAfter } from '../utils/backoff.util';
import { bounds, isAppError, limited, refusal, upstream } from '../utils/error.util';
import { CONNECTOR_MAX_ATTEMPTS } from '../config/constants.config';
import type { Headers, ResolvedTls, WireResponse } from '../engine/transports/contract.transport';

/**
 * How Silo itself sends a request to somebody else's system.
 *
 * ── THE ADDRESS THAT IS CHECKED IS THE ADDRESS THAT IS CONNECTED TO ──────
 *
 * The first client checked the HOSTNAME against the block list and then let the
 * runtime resolve it. A public name that resolves to `10.0.0.5`, or to the cloud
 * metadata server, passed the check and was connected to — and a name can be
 * made to resolve differently between a check and a connect. So the check runs
 * INSIDE the connection's own lookup: every address a connection could use is
 * resolved, every one is checked, and the socket is given only those.
 *
 * ── BYTES ARE COUNTED AFTER DECOMPRESSION ─────────────────────────────────
 *
 * A 32 MB limit measured on the wire is a 3 GB limit for a gzip bomb. The body
 * is streamed, decompressed here, counted as it arrives, and abandoned the moment
 * it passes the bound — with a ratio cap, because a small body that inflates a
 * hundredfold is not a response anybody meant to send (MANIFEST-V2 §9.6).
 *
 * ── BINARY IS BINARY ──────────────────────────────────────────────────────
 *
 * The body comes back as bytes. Decoding to text is the parser's decision, made
 * with the connector's charset — an Excel file read as a string is destroyed.
 *
 * ── TLS PER CONNECTION, AND NEVER "SKIP VERIFICATION" ─────────────────────
 *
 * A private CA, a client certificate or a pinned server fingerprint belongs to
 * one connection, so each distinct TLS configuration gets its own dispatcher.
 * There is no option that turns verification off; pinning a fingerprint replaces
 * chain verification with something stricter, not with nothing.
 */

export interface HttpWire {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | string | null;
}

export interface HttpSendOptions {
  tls: ResolvedTls;
  timeoutMs: number;
  maxBytes: number;
  /** Reads retry on 429, 408 and 5xx; writes never do. */
  retry: boolean;
  signal?: AbortSignal;
  /**
   * TRUE ONLY INSIDE A CUSTOMER'S AGENT, where the target is private by design
   * and the agent's own allow-list is the guard. Silo never sets it.
   */
  allowPrivate?: boolean;
}

/** More decompressed bytes than this multiple of the compressed ones is refused as a bomb. */
const MAX_RATIO = 100;
/** Below this the ratio is not judged — a tiny gzipped JSON legitimately inflates a lot. */
const RATIO_FLOOR = 1_000_000;
/** How long a source may make us wait inside one request before the wait is reported instead. */
const RETRY_AFTER_CEILING_MS = 5_000;

/* ── Test seams ─────────────────────────────────────────────────────────── */

type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))),
  );

let resolver: Resolver = systemResolver;
let testDispatcher: Dispatcher | null = null;

/**
 * DEVELOPMENT ONLY, AND READ HERE BECAUSE THIS IS THE ONE GUARD. Every
 * transport resolves through `resolveGuarded`, so this is the single switch
 * that lets a laptop reach its own demo database. Production refuses to start
 * with it set.
 */
const fromEnvironment = process.env.NODE_ENV !== 'production' && process.env.ALLOW_PRIVATE_SOURCES === 'true';
let privateSources = fromEnvironment;

/** Whether a private address may be reached from Silo itself — never, in production. */
export const privateSourcesAllowed = (): boolean => privateSources;

/**
 * For tests only: a network that answers without sockets, and a resolver that
 * answers without DNS. A suite that resolved real names would be a suite that
 * fails on an aeroplane and passes against a hijacked resolver.
 */
export function useNetworkForTests(options: { dispatcher?: Dispatcher; resolve?: Resolver; privateSources?: boolean }): void {
  if (options.dispatcher) testDispatcher = options.dispatcher;
  if (options.resolve) resolver = options.resolve;
  if (options.privateSources !== undefined) privateSources = options.privateSources;
}

export function resetNetworkForTests(): void {
  testDispatcher = null;
  resolver = systemResolver;
  privateSources = fromEnvironment;
  for (const agent of agents.values()) void agent.close();
  agents.clear();
}

/* ── The guard ──────────────────────────────────────────────────────────── */

export class BlockedAddress extends Error {
  constructor(readonly host: string, readonly address: string) {
    super(`Requests to ${host} (${address}) are not permitted.`);
    this.name = 'BlockedAddress';
  }
}

/**
 * Every address a name resolves to, refused if ANY is private.
 *
 * ANY, NOT FIRST. A name with one public and one private record would otherwise
 * be connected to whichever the socket happened to try.
 */
export async function resolveGuarded(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (privateSources) return isIP(host) ? [{ address: host, family: isIP(host) }] : resolver(host);
  if (isBlockedHost(host)) throw new BlockedAddress(host, host);

  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
  for (const one of addresses) {
    if (isBlockedHost(one.address) || isPrivateV6(one.address)) throw new BlockedAddress(host, one.address);
  }
  return addresses;
}

/** IPv6 unique-local and IPv4-mapped private addresses, which the v4 patterns do not see. */
function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped ? isBlockedHost(mapped[1]!) : false;
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  resolveGuarded(hostname).then(
    (addresses) => {
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      if (all) (callback as (e: null, a: typeof addresses) => void)(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    },
    (error: unknown) => callback(error as NodeJS.ErrnoException, '', 0),
  );
};

/* ── Sockets a protocol library opens itself ────────────────────────────── */

/**
 * THE SAME GUARD, FOR A LIBRARY THAT OPENS ITS OWN SOCKETS. IMAP, Kafka and
 * gRPC clients connect for themselves — Kafka to whichever brokers the cluster
 * advertises, which a hostile cluster could point anywhere. Handing them this as
 * the socket's DNS lookup puts the check where the connect happens, exactly as
 * the HTTP dispatcher does. Inside an agent there is no guard: the target is
 * private by design and the agent's allow-list decides.
 */
export const socketLookup = (inAgent: boolean): LookupFunction | undefined => (inAgent ? undefined : guardedLookup);

/** A fingerprint as the manifest writes it, from a peer certificate's `fingerprint256`. */
export const certificateFingerprint = (hex: string): string => fingerprintOf(hex);

/**
 * Node's TLS options from a connection's TLS, for a library that opens its own
 * socket. Verification is always on. A pinned fingerprint is checked by the
 * caller once the handshake completes — `checkServerIdentity` is not consulted
 * when the chain fails, so pinning cannot be done in here.
 */
export function nodeTls(tls: ResolvedTls, inAgent: boolean): {
  minVersion: 'TLSv1.2' | 'TLSv1.3';
  ca?: string;
  cert?: string;
  key?: string;
  servername?: string;
  rejectUnauthorized: boolean;
  lookup?: LookupFunction;
} {
  return {
    minVersion: tls.minVersion,
    ...(tls.ca && !tls.systemTrust ? { ca: tls.ca } : {}),
    ...(tls.cert ? { cert: tls.cert, key: tls.key } : {}),
    ...(tls.servername ? { servername: tls.servername } : {}),
    rejectUnauthorized: !tls.fingerprint,
    ...(inAgent ? {} : { lookup: guardedLookup }),
  };
}

/* ── Dispatchers, one per TLS configuration ─────────────────────────────── */

const agents = new Map<string, Agent>();

/** `SHA256:base64` as the manifest writes it, from Node's `AB:CD:…` hex. */
const fingerprintOf = (hex: string): string =>
  `SHA256:${Buffer.from(hex.replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')}`;

function agentFor(tls: ResolvedTls, allowPrivate: boolean): Agent {
  const key = JSON.stringify({ ...tls, allowPrivate });
  const existing = agents.get(key);
  if (existing) return existing;

  const pinning = Boolean(tls.fingerprint);
  const base = buildConnector({
    minVersion: tls.minVersion,
    ca: tls.systemTrust ? undefined : tls.ca,
    cert: tls.cert,
    key: tls.key,
    servername: tls.servername,
    /*
     * A PINNED FINGERPRINT REPLACES CHAIN VERIFICATION WITH SOMETHING STRICTER:
     * the leaf must be exactly this certificate. The chain is not checked then —
     * a self-signed on-prem certificate has none — and the fingerprint is checked
     * below before the socket is handed over.
     */
    rejectUnauthorized: !pinning,
    ...(allowPrivate ? {} : { lookup: guardedLookup }),
  } as buildConnector.BuildOptions);

  const connect: buildConnector.connector = (options, callback) =>
    base(options, (error, socket) => {
      if (error || !socket) return callback(error ?? new Error('connect failed'), null);
      if (pinning) {
        const peer = (socket as unknown as { getPeerCertificate(): { fingerprint256?: string } }).getPeerCertificate();
        const seen = peer.fingerprint256 ? fingerprintOf(peer.fingerprint256) : null;
        if (!seen || seen.replace(/=+$/, '') !== tls.fingerprint!.replace(/=+$/, '')) {
          socket.destroy();
          return callback(new Error(`The server presented a certificate (${seen ?? 'none'}) that is not the one pinned.`), null);
        }
      }
      callback(null, socket);
    });

  const agent = new Agent({ connect, connections: 16 });
  agents.set(key, agent);
  return agent;
}

/* ── Sending ────────────────────────────────────────────────────────────── */

function headersOf(raw: Record<string, string | string[] | undefined>): Headers {
  const out: Headers = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (key === 'set-cookie' || key === 'link' || key === 'www-authenticate') {
      out[key] = Array.isArray(value) ? value : [value];
    } else {
      out[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return out;
}

/**
 * Read a body, decompressed, counting as it comes.
 *
 * THE BOUND IS A REFUSAL, NEVER A TRUNCATION. Half a JSON document parses as
 * nothing, and half a CSV parses as a confident, shorter answer.
 */
async function readBounded(body: Readable, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
  let compressed = 0;
  body.on('data', (chunk: Buffer) => {
    compressed += chunk.length;
  });

  const enc = (encoding ?? '').toLowerCase().trim();
  const stream: Readable =
    enc === 'gzip' || enc === 'x-gzip'
      ? body.pipe(createGunzip())
      : enc === 'deflate'
        ? body.pipe(createInflate())
        : enc === 'br'
          ? body.pipe(createBrotliDecompress())
          : body;

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy();
      throw bounds({
        message: `The source sent more than ${Math.round(maxBytes / 1_048_576)} MB. Ask for less — filter at the source, or ask for a total.`,
        code: 'bounds.bytes',
        detail: { limit: maxBytes },
      });
    }
    if (stream !== body && total > RATIO_FLOOR && compressed > 0 && total / compressed > MAX_RATIO) {
      body.destroy();
      throw bounds({
        message: 'The source sent a compressed body that expands far beyond its size. It was not read.',
        code: 'bounds.decompression_ratio',
        detail: { compressed, decompressed: total },
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send one HTTP request from Silo (or, with `allowPrivate`, from an agent) and
 * return what came back.
 *
 * REDIRECTS ARE NOT FOLLOWED, for the reason the first client gave: a permitted
 * host answering `302 http://169.254.169.254/` would otherwise be followed
 * without passing the guard again. A 3xx is returned as a response and judged
 * like any other.
 */
export async function sendHttp(wire: HttpWire, options: HttpSendOptions): Promise<WireResponse> {
  const target = new URL(wire.url);

  if (!options.allowPrivate && !privateSources && target.protocol !== 'https:') {
    throw refusal({
      message: `Silo only reaches a system directly over HTTPS. ${target.origin} is not.`,
      code: 'refusal.plaintext',
    });
  }

  const dispatcher = testDispatcher ?? agentFor(options.tls, Boolean(options.allowPrivate));
  const attempts = options.retry ? CONNECTOR_MAX_ATTEMPTS : 1;
  const started = Date.now();

  /* A test network answers without sockets, so the guard is run here for it. */
  if (testDispatcher && !options.allowPrivate) await guardOrRefuse(target.hostname);

  for (let attempt = 1; ; attempt++) {
    let response: Dispatcher.ResponseData;
    try {
      response = await undiciRequest(target, {
        dispatcher,
        method: wire.method as Dispatcher.HttpMethod,
        headers: wire.headers,
        body: wire.body ?? undefined,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
        signal: options.signal,
      });
    } catch (error) {
      const blocked = blockedIn(error);
      if (blocked) {
        throw refusal({ message: blocked.message, code: 'refusal.blocked_host', detail: { host: blocked.host } });
      }
      if (attempt < attempts) {
        await sleep(nextDelay(attempt, null));
        continue;
      }
      const timedOut = error instanceof Error && /timeout/i.test(error.name + error.message);
      throw upstream({
        message: timedOut
          ? `${target.host} did not respond within ${Math.round(options.timeoutMs / 1000)} seconds.`
          : `${target.host} could not be reached.`,
        code: timedOut ? 'upstream.timeout' : 'upstream.unreachable',
        cause: error,
      });
    }

    const headers = headersOf(response.headers as Record<string, string | string[] | undefined>);
    const status = response.statusCode;

    if (options.retry && attempt < attempts && (status === 429 || status === 408 || status >= 500)) {
      await response.body.dump();
      const retryAfter = typeof headers['retry-after'] === 'string' ? headers['retry-after'] : null;
      const delay = nextDelay(attempt, retryAfter);
      if (delay > RETRY_AFTER_CEILING_MS && status === 429) {
        throw limited({
          message: 'The source is rate limiting Silo. It will be tried again shortly.',
          code: 'limited.source',
          detail: { retryAfterMs: parseRetryAfter(retryAfter) },
        });
      }
      await sleep(Math.min(delay, RETRY_AFTER_CEILING_MS));
      continue;
    }

    const encoding = typeof headers['content-encoding'] === 'string' ? headers['content-encoding'] : undefined;
    const body = await readBounded(response.body as unknown as Readable, encoding, options.maxBytes);

    return {
      status,
      code: null,
      message: null,
      headers,
      body,
      contentType: typeof headers['content-type'] === 'string' ? headers['content-type'] : null,
      durationMs: Date.now() - started,
    };
  }
}

async function guardOrRefuse(hostname: string): Promise<void> {
  try {
    await resolveGuarded(hostname);
  } catch (error) {
    if (error instanceof BlockedAddress) {
      throw refusal({ message: error.message, code: 'refusal.blocked_host', detail: { host: error.host } });
    }
    throw upstream({ message: `${hostname} could not be resolved.`, code: 'upstream.unreachable', cause: error });
  }
}

function blockedIn(error: unknown): BlockedAddress | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof BlockedAddress) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * A challenge and a response on ONE connection — NTLM and Negotiate, which
 * authenticate the socket rather than the request (MANIFEST-V2 §9.1, F2).
 *
 * `first` is sent; `second` is given the `WWW-Authenticate` header the server
 * answered with and returns the request to send next on the same connection,
 * or null when the first answer is final. Only ever called inside an agent.
 */
export async function handshakeHttp(
  first: HttpWire,
  second: (challenge: string[], firstStatus: number) => Promise<HttpWire | null>,
  options: HttpSendOptions,
): Promise<WireResponse> {
  const target = new URL(first.url);
  const started = Date.now();
  const tls = options.tls;
  const client = new Client(target.origin, {
    pipelining: 1,
    keepAliveTimeout: 30_000,
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs,
    connect: {
      ...(tls.ca && !tls.systemTrust ? { ca: tls.ca } : {}),
      ...(tls.cert ? { cert: tls.cert, key: tls.key } : {}),
      ...(tls.servername ? { servername: tls.servername } : {}),
      minVersion: tls.minVersion,
      rejectUnauthorized: true,
      ...(options.allowPrivate ? {} : { lookup: guardedLookup }),
    } as buildConnector.BuildOptions,
  });
  const send = async (wire: HttpWire) => {
    const url = new URL(wire.url);
    const response = await client.request({
      path: `${url.pathname}${url.search}`,
      method: wire.method as Dispatcher.HttpMethod,
      headers: { ...wire.headers, connection: 'keep-alive' },
      body: wire.body ?? undefined,
      signal: options.signal,
    });
    const headers = headersOf(response.headers as Record<string, string | string[] | undefined>);
    const encoding = typeof headers['content-encoding'] === 'string' ? headers['content-encoding'] : undefined;
    const body = await readBounded(response.body as unknown as Readable, encoding, options.maxBytes);
    return { status: response.statusCode, headers, body };
  };
  try {
    let answer = await send(first);
    const challenge = answer.headers['www-authenticate'];
    const next = await second(Array.isArray(challenge) ? challenge : challenge ? [challenge] : [], answer.status);
    if (next) answer = await send(next);
    return {
      status: answer.status,
      code: null,
      message: null,
      headers: answer.headers,
      body: answer.body,
      contentType: typeof answer.headers['content-type'] === 'string' ? answer.headers['content-type'] : null,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (isAppError(error)) throw error;
    throw upstream({ message: `${target.host} could not be reached.`, code: 'upstream.unreachable', cause: error });
  } finally {
    await client.close().catch(() => {});
  }
}
