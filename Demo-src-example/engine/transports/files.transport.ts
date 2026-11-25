import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join as joinFs, posix } from 'node:path';
import { Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import type { TransportV2 } from '../../schemas/manifest.schema';
import { BlockedAddress, resolveGuarded } from '../../infra/network.infra';
import { bounds, isAppError, refusal, upstream } from '../../utils/error.util';
import type { AuthSurface, SocketAuth, Transport, WireRequest, WireResponse } from './contract.transport';

/**
 * Files on somebody's server: SFTP, FTP and FTPS, and SMB shares.
 *
 * ── ONE MODEL FOR THREE PROTOCOLS ─────────────────────────────────────────
 *
 * A directory, a pattern, and which match to take. `newest` and `oldest`
 * return that one file's bytes, parsed by the operation's format like any
 * other body. `all` returns the LISTING — name, path, size, modified — so a
 * pipeline's next step can fetch each file by its path; a hundred files are a
 * bounded fan-out, not one response nobody can hold.
 *
 * ── A PATTERN IS A GLOB, NOT A REGULAR EXPRESSION ─────────────────────────
 *
 * `*` and `?` only, matched against a name capped in length, so a document
 * cannot supply a pattern that takes a minute to match. A path may not climb
 * out of the transport's directory.
 *
 * ── SMB IS READ BY THE OPERATING SYSTEM, INSIDE THE AGENT ─────────────────
 *
 * Every SMB share Silo will meet is on a customer's network, behind their
 * domain. The agent reads it through the operating system's own client — a
 * UNC path on Windows, the mount the admin configured elsewhere — so Kerberos,
 * signing and DFS referrals are the OS's, done properly, rather than a partial
 * reimplementation of SMB3 in JavaScript.
 */

export interface FileWire extends WireRequest {
  kind: 'sftp' | 'ftp' | 'smb';
  host: string;
  port: number;
  directory: string;
  pattern: string;
  pick: 'newest' | 'oldest' | 'all';
  /* ftp */
  secure?: 'explicit' | 'implicit' | 'none';
  /* sftp */
  hostKeyFingerprint?: string | null;
  /* smb */
  share?: string;
  domain?: string | null;
}

export interface Entry {
  name: string;
  path: string;
  size: number;
  modified: string;
}

const CONNECT_TIMEOUT_MS = 15_000;
const NAME_MAX = 512;

/** A glob as a matcher, `*` and `?` only, case-insensitive. */
export function globMatcher(pattern: string): (name: string) => boolean {
  if (pattern.length > 256) throw refusal({ message: 'A file pattern is at most 256 characters.', code: 'refusal.request_unbuildable' });
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  const re = new RegExp(`^${source}$`, 'i');
  return (name) => name.length <= NAME_MAX && re.test(name);
}

/** The directory and the pattern, with no way out of the directory. */
function locate(directory: string, path: string): { directory: string; pattern: string } {
  const joined = posix.normalize(posix.join(directory || '/', path || '*'));
  const base = posix.normalize(directory || '/');
  if (joined !== base && !joined.startsWith(base.endsWith('/') ? base : `${base}/`)) {
    throw refusal({ message: 'A file path may not step outside the connection’s directory.', code: 'refusal.request_unbuildable' });
  }
  return { directory: posix.dirname(joined), pattern: posix.basename(joined) };
}

const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v));

function choose(entries: Entry[], pattern: string, pick: FileWire['pick']): Entry[] {
  const matches = entries.filter((e) => globMatcher(pattern)(e.name)).sort((a, b) => b.modified.localeCompare(a.modified));
  if (pick === 'all') return matches;
  const one = pick === 'newest' ? matches[0] : matches.at(-1);
  return one ? [one] : [];
}

function listingResponse(entries: Entry[], started: number): WireResponse {
  return {
    status: null,
    code: null,
    message: null,
    headers: {},
    body: Buffer.from(JSON.stringify(entries)),
    contentType: 'application/json',
    durationMs: Date.now() - started,
  };
}

function fileResponse(entry: Entry, bytes: Buffer, started: number, extra: Record<string, string> = {}): WireResponse {
  return {
    status: null,
    code: null,
    message: null,
    headers: { 'file-name': entry.name, 'file-path': entry.path, 'last-modified': entry.modified, ...extra },
    body: bytes,
    contentType: null,
    durationMs: Date.now() - started,
  };
}

const failure = (code: string, message: string, started: number): WireResponse => ({
  status: null,
  code,
  message: message.slice(0, 500),
  headers: {},
  body: Buffer.alloc(0),
  contentType: null,
  durationMs: Date.now() - started,
});

/** What a file server's failure means, read from its words — they have no codes worth the name. */
function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication|permission denied|login incorrect|530|all configured authentication|access is denied|logon failure/i.test(message)) return 'AUTH';
  if (/no such file|ENOENT|550|not found|cannot find/i.test(message)) return 'NOT_FOUND';
  if (/timed? ?out|ETIMEDOUT/i.test(message)) return 'TIMEOUT';
  return 'ERROR';
}

const FLOOR = { AUTH: 'auth', NOT_FOUND: 'not_found', NO_MATCH: 'not_found', TIMEOUT: 'bounds', ERROR: 'upstream' } as const;

async function guarded(host: string, inAgent: boolean): Promise<string> {
  if (inAgent) return host;
  try {
    const [first] = await resolveGuarded(host);
    return first!.address;
  } catch (error) {
    if (error instanceof BlockedAddress) {
      throw refusal({ message: `${host} is a private address. Reach it through the Silo agent.`, code: 'refusal.blocked_host', detail: { host } });
    }
    throw upstream({ message: `${host} could not be resolved.`, code: 'upstream.unreachable', cause: error });
  }
}

function socketOnly(where: string): never {
  throw refusal({ message: `A file server takes its credential on the connection, not at ${where}.`, code: 'refusal.auth_place_unsupported' });
}

function surface(socket: SocketAuth): AuthSurface {
  return {
    setHeader: (n) => socketOnly(`header:${n}`),
    setQuery: (n) => socketOnly(`query:${n}`),
    setBodyPath: (p) => socketOnly(`body:${p}`),
    setCookie: (n) => socketOnly(`cookie:${n}`),
    setForm: (n) => socketOnly(`form:${n}`),
    setSoapHeader: (p) => socketOnly(`soap:${p}`),
    socket,
  };
}

/* ── SFTP ───────────────────────────────────────────────────────────────── */

/** `SHA256:` plus unpadded base64, as OpenSSH prints it. */
export const sshFingerprint = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

export const sftp: Transport<FileWire> = {
  kind: 'sftp',
  writes: false,

  prepare({ transport, request }) {
    const t = transport as Extract<TransportV2, { kind: 'sftp' }>;
    const where = locate(str(request.connection.directory, '/'), str(request.path, '*'));
    return {
      kind: 'sftp',
      host: str(request.connection.host),
      port: Number(request.connection.port ?? 22),
      ...where,
      pick: request.pick ?? 'newest',
      hostKeyFingerprint: t.hostKeyFingerprint ?? null,
    };
  },

  authSurface: (_wire, socket) => surface(socket),

  async send(wire, options) {
    const started = Date.now();
    const client = new SftpClient();
    let seenKey: string | null = null;
    try {
      const host = await guarded(wire.host, options.inAgent === true);
      if (!options.socket.privateKey && !options.socket.password) throw refusal({ message: 'This connection has no key or password.', code: 'refusal.credential_missing' });
      await client.connect({
        host,
        port: wire.port,
        username: options.socket.username,
        ...(options.socket.privateKey ? { privateKey: options.socket.privateKey, passphrase: options.socket.passphrase } : { password: options.socket.password }),
        readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          seenKey = sshFingerprint(key);
          return !wire.hostKeyFingerprint || seenKey.replace(/=+$/, '') === wire.hostKeyFingerprint.replace(/=+$/, '');
        },
      });
      const listed = await client.list(wire.directory);
      const entries: Entry[] = listed
        .filter((e) => e.type === '-')
        .map((e) => ({ name: e.name, path: posix.join(wire.directory, e.name), size: e.size, modified: new Date(e.modifyTime).toISOString() }));
      const chosen = choose(entries, wire.pattern, wire.pick);
      if (wire.pick === 'all') return listingResponse(chosen, started);
      const one = chosen[0];
      if (!one) return failure('NO_MATCH', `No file matching ${wire.pattern} in ${wire.directory}.`, started);
      if (one.size > options.maxBytes) throw bounds({ message: `${one.name} is larger than one question may read.`, code: 'bounds.bytes', detail: { observed: one.size, limit: options.maxBytes } });
      const bytes = (await client.get(one.path)) as Buffer;
      return fileResponse(one, bytes, started, seenKey ? { 'x-host-key': seenKey } : {});
    } catch (error) {
      if (isAppError(error)) throw error;
      if (wire.hostKeyFingerprint && seenKey && seenKey !== wire.hostKeyFingerprint) {
        throw refusal({
          message: `The server's host key (${seenKey}) is not the one this connection was confirmed with. Silo did not send the credential.`,
          code: 'refusal.host_key_changed',
        });
      }
      return failure(codeOf(error), error instanceof Error ? error.message : String(error), started);
    } finally {
      await client.end().catch(() => {});
    }
  },

  floor: (res) => (res.code === null ? null : { means: FLOOR[res.code as keyof typeof FLOOR] ?? 'upstream' }),
};

/* ── FTP and FTPS ───────────────────────────────────────────────────────── */

export const ftp: Transport<FileWire> = {
  kind: 'ftp',
  writes: false,

  prepare({ transport, request }) {
    const t = transport as Extract<TransportV2, { kind: 'ftp' }>;
    const where = locate(str(request.connection.directory, '/'), str(request.path, '*'));
    return {
      kind: 'ftp',
      host: str(request.connection.host),
      port: Number(request.connection.port ?? (t.secure === 'implicit' ? 990 : 21)),
      ...where,
      pick: request.pick ?? 'newest',
      secure: t.secure,
    };
  },

  authSurface: (_wire, socket) => surface(socket),

  async send(wire, options) {
    const started = Date.now();
    const client = new FtpClient(CONNECT_TIMEOUT_MS);
    try {
      if (wire.secure === 'none' && options.inAgent !== true) {
        throw refusal({ message: 'Unencrypted FTP is only reached through the Silo agent.', code: 'refusal.plaintext' });
      }
      const host = await guarded(wire.host, options.inAgent === true);
      const tls = options.socket.tls;
      await client.access({
        host,
        port: wire.port,
        user: options.socket.username ?? 'anonymous',
        password: options.socket.password ?? '',
        secure: wire.secure === 'implicit' ? 'implicit' : wire.secure === 'explicit',
        secureOptions: {
          servername: tls.servername ?? wire.host,
          minVersion: tls.minVersion,
          rejectUnauthorized: true,
          ...(tls.ca ? { ca: tls.ca } : {}),
          ...(tls.cert ? { cert: tls.cert, key: tls.key } : {}),
        },
      });
      const listed = await client.list(wire.directory);
      const entries: Entry[] = listed
        .filter((e) => e.isFile)
        .map((e) => ({ name: e.name, path: posix.join(wire.directory, e.name), size: e.size, modified: e.modifiedAt ? e.modifiedAt.toISOString() : '' }));
      const chosen = choose(entries, wire.pattern, wire.pick);
      if (wire.pick === 'all') return listingResponse(chosen, started);
      const one = chosen[0];
      if (!one) return failure('NO_MATCH', `No file matching ${wire.pattern} in ${wire.directory}.`, started);
      if (one.size > options.maxBytes) throw bounds({ message: `${one.name} is larger than one question may read.`, code: 'bounds.bytes', detail: { observed: one.size, limit: options.maxBytes } });
      const chunks: Buffer[] = [];
      let total = 0;
      await client.downloadTo(
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            total += chunk.length;
            if (total > options.maxBytes) return done(bounds({ message: `${one.name} is larger than one question may read.`, code: 'bounds.bytes' }));
            chunks.push(chunk);
            done();
          },
        }),
        one.path,
      );
      return fileResponse(one, Buffer.concat(chunks), started);
    } catch (error) {
      if (isAppError(error)) throw error;
      return failure(codeOf(error), error instanceof Error ? error.message : String(error), started);
    } finally {
      client.close();
    }
  },

  floor: (res) => (res.code === null ? null : { means: FLOOR[res.code as keyof typeof FLOOR] ?? 'upstream' }),
};

/* ── SMB, through the agent's operating system ──────────────────────────── */

/**
 * Where a share is on this machine. On Windows, the UNC path; elsewhere, the
 * mount the agent's admin configured for `\\host\share`. Silo itself never
 * reads a share, so this runs only inside the agent.
 */
export type ShareResolver = (host: string, share: string) => string | null;

let resolveShare: ShareResolver = (host, share) => (process.platform === 'win32' ? `\\\\${host}\\${share}` : null);

/** The agent sets how shares are found on its machine. */
export function useShareResolver(resolver: ShareResolver): void {
  resolveShare = resolver;
}

export const smb: Transport<FileWire> = {
  kind: 'smb',
  writes: false,

  prepare({ request }) {
    const where = locate(str(request.connection.directory, '/'), str(request.path, '*'));
    return {
      kind: 'smb',
      host: str(request.connection.host),
      port: Number(request.connection.port ?? 445),
      share: str(request.connection.share),
      domain: request.connection.domain === undefined || request.connection.domain === null ? null : String(request.connection.domain),
      ...where,
      pick: request.pick ?? 'newest',
    };
  },

  authSurface: (_wire, socket) => surface(socket),

  async send(wire, options) {
    const started = Date.now();
    if (options.inAgent !== true) {
      throw refusal({ message: 'A file share is read inside your network, through the Silo agent.', code: 'refusal.agent_only' });
    }
    const root = resolveShare(wire.host, wire.share ?? '');
    if (!root) {
      throw refusal({
        message: `The agent does not know where \\\\${wire.host}\\${wire.share} is on its machine. Map it in the agent's settings.`,
        code: 'refusal.share_unmapped',
      });
    }
    try {
      const directory = joinFs(root, ...wire.directory.split('/').filter(Boolean));
      const names = await readdir(directory);
      const entries: Entry[] = [];
      for (const name of names) {
        const info = await stat(joinFs(directory, name)).catch(() => null);
        if (info?.isFile()) entries.push({ name, path: posix.join(wire.directory, name), size: info.size, modified: info.mtime.toISOString() });
      }
      const chosen = choose(entries, wire.pattern, wire.pick);
      if (wire.pick === 'all') return listingResponse(chosen, started);
      const one = chosen[0];
      if (!one) return failure('NO_MATCH', `No file matching ${wire.pattern} in ${wire.directory}.`, started);
      if (one.size > options.maxBytes) throw bounds({ message: `${one.name} is larger than one question may read.`, code: 'bounds.bytes', detail: { observed: one.size, limit: options.maxBytes } });
      return fileResponse(one, await readFile(joinFs(directory, one.name)), started);
    } catch (error) {
      if (isAppError(error)) throw error;
      return failure(codeOf(error), error instanceof Error ? error.message : String(error), started);
    }
  },

  floor: (res) => (res.code === null ? null : { means: FLOOR[res.code as keyof typeof FLOOR] ?? 'upstream' }),
};
