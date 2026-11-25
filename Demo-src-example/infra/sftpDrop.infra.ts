import SftpClient from 'ssh2-sftp-client';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isBlockedHost } from './httpClient.infra';

/**
 * Import §2 — a watched location, reached over SFTP.
 *
 * ── Read-only, and says so by having nothing else ──────────────────────────
 *
 * List a directory, fetch a file, disconnect. There is no rename, no delete and
 * no upload here, for the reason `sftp.transport` gives: writing into a folder
 * another system exports into is how two systems process one file twice.
 *
 * ── The key is pinned ──────────────────────────────────────────────────────
 *
 * The SFTP connector trusts whichever server answers. A watched location holds
 * a standing credential used on a schedule with nobody watching, so the host
 * key a person confirmed is required, and any other key ends the connection
 * before the credential is sent.
 *
 * ── The address is checked after it is resolved ────────────────────────────
 *
 * A hostname that passes the blocked-host check can still resolve to the
 * metadata server or a private range. So it is resolved here, every address it
 * resolves to is checked, and the connection goes to the address that was
 * checked — not to the name, which could resolve somewhere else a second later.
 */

const CONNECT_TIMEOUT_MS = 15_000;

export class BlockedAddress extends Error {}
export class HostKeyMismatch extends Error {}
export class FileTooLarge extends Error {}

export interface DropEntry {
  name: string;
  bytes: number;
  modifiedAt: Date;
}

export interface Drop {
  /** Regular files only. */
  list(directory: string): Promise<DropEntry[]>;
  get(path: string, maxBytes: number): Promise<Buffer>;
  end(): Promise<void>;
}

/** The OpenSSH form — `SHA256:` and unpadded base64 — which is what `ssh-keygen -lf` prints. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** An IPv4 address written as IPv6 is still that IPv4 address. */
function blocked(address: string): boolean {
  const plain = address.toLowerCase().replace(/^::ffff:/, '');
  return isBlockedHost(plain) || plain === '::' || plain === '0:0:0:0:0:0:0:1';
}

async function addressFor(host: string): Promise<string> {
  if (blocked(host)) throw new BlockedAddress(`Connections to ${host} are not permitted.`);

  const found = await lookup(host, { all: true, verbatim: true });
  if (found.length === 0 || found.some((one) => blocked(one.address))) {
    throw new BlockedAddress(`${host} resolves to an address that is not permitted.`);
  }
  return found[0]!.address;
}

/**
 * The key a server presents, for a person to confirm before anything is sent.
 *
 * NO CREDENTIAL IS OFFERED. The verifier refuses every key after recording it,
 * so the connection ends at the key exchange, before authentication begins.
 */
export async function presentedFingerprint(input: { host: string; port: number }): Promise<string> {
  const address = await addressFor(input.host);
  const presented: { key?: string } = {};
  const client = new SftpClient();

  try {
    await client.connect({
      host: address,
      port: input.port,
      username: 'silo-host-key-check',
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        presented.key = fingerprintOf(key);
        return false;
      },
    });
  } catch {
    /* Refused by the verifier above, which is the point. */
  } finally {
    await client.end().catch(() => {});
  }

  if (!presented.key) throw new Error('The server did not present a host key.');
  return presented.key;
}

export async function openDrop(input: {
  host: string;
  port: number;
  username: string;
  secret: string;
  fingerprint: string;
}): Promise<Drop> {
  const address = await addressFor(input.host);
  const presented: { key?: string } = {};
  const client = new SftpClient();

  try {
    await client.connect({
      host: address,
      port: input.port,
      username: input.username,
      /* A key or a password, told apart by its shape, as the SFTP connector does. */
      ...(input.secret.includes('PRIVATE KEY') ? { privateKey: input.secret } : { password: input.secret }),
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        presented.key = fingerprintOf(key);
        return presented.key === input.fingerprint;
      },
    });
  } catch (error) {
    await client.end().catch(() => {});
    if (presented.key && presented.key !== input.fingerprint) {
      throw new HostKeyMismatch('The server presented a different host key from the one confirmed.');
    }
    throw error;
  }

  return {
    async list(directory) {
      const listing = await client.list(directory);
      return listing
        .filter((entry) => entry.type === '-')
        .map((entry) => ({ name: entry.name, bytes: entry.size, modifiedAt: new Date(entry.modifyTime) }));
    },

    /*
     * THE SIZE IS ASKED FOR AGAIN, IMMEDIATELY BEFORE READING. A file still
     * being exported grows between the listing and the fetch, and the fetch
     * reads it into memory.
     */
    async get(path, maxBytes) {
      const stats = await client.stat(path);
      if (stats.size > maxBytes) throw new FileTooLarge(`${path} is larger than ${maxBytes} bytes.`);

      const body = (await client.get(path)) as Buffer;
      if (body.byteLength > maxBytes) throw new FileTooLarge(`${path} is larger than ${maxBytes} bytes.`);
      return body;
    },

    async end() {
      await client.end().catch(() => {});
    },
  };
}
