// SFTP through the single mediator (spec 14.4, 61.3): the credential service opens the
// connection's SSH login and runs the session itself, so the login never leaves it; the cell
// asks for a directory's names or one file's bytes and parses them.
//
// - The server is the manifest's sftp:// host (a {params.<name>} part is one DNS label), on
//   its port (22 by default), reached under the cell's egress rules: public addresses, or a
//   private one inside the organisation's link (egress.infra createTcpEgress).
// - Pinned: the server must present the host key whose SHA-256 the connection declares
//   (host_key_sha256, "SHA256:" and base64, as OpenSSH prints it). Any other key is refused
//   before authentication, so the login is never sent to an impostor.
// - The login: a username with a password (username_password) or a private key and its
//   optional passphrase (ssh_key). A key stays a Buffer; ssh2 takes a password as a string,
//   the one place a secret becomes a JavaScript string, inside this process only.
// - Paths: the base path from the URL, then the source's relative directory (segments,
//   never ".."), then a file name with no separator. A file over its bound is refused,
//   never truncated. Every use is an unwrap on the ledger, as for any opened login.

import { createHash, timingSafeEqual } from 'node:crypto';
// ssh2 is CommonJS: its classes come from the default export.
import ssh2, { type SFTPWrapper } from 'ssh2';
import type { z } from 'zod';
import { SFTP_HOST_KEY_PARAMETER } from '../../contracts/connect/manifest.contract.ts';
import { parametersOf } from '../../contracts/connect/parameters.contract.ts';
import { SFTP_MAX_LIST_ENTRIES, type sendSftpRequest } from '../../contracts/credential/connectionCredential.contract.ts';
import type { TcpEgress } from '../../infra/egress.infra.ts';
import { zeroise } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { HOST_KEY, sftpTarget } from '../../utils/sftpTarget.util.ts';
import type { Caller, ConnectionCredentials, ConnectionUnwrapReason } from './connectionCredential.service.ts';

type Operation = z.output<typeof sendSftpRequest.body>['operation'];
type Reply = z.output<typeof sendSftpRequest.response>;

export { sftpTarget } from '../../utils/sftpTarget.util.ts';

/** OpenSSH's fingerprint of a host key: "SHA256:" and unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a.replace(/=+$/, ''));
  const y = Buffer.from(b.replace(/=+$/, ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

const sourceError = (message: string, code: string, retryable = false) => new AppError('upstream', message, { code, retryable });

export function createSftpMediator(deps: { credentials: ConnectionCredentials; tcp: TcpEgress; timeoutMs?: number }) {
  const timeoutMs = deps.timeoutMs ?? 30_000;

  async function session<T>(socket: import('node:net').Socket, login: { username: string; password?: string; privateKey?: Buffer; passphrase?: Buffer },
    pinned: string, use: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = new ssh2.Client();
    let mismatch = false;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => resolve());
        client.once('error', (error: Error & { level?: string }) => reject(mismatch
          ? new AppError('forbidden', 'the server presented a host key other than the one the connection pins; nothing was sent', { code: 'sftp.host_key_mismatch' })
          : error.level === 'client-authentication'
            ? new AppError('unauthenticated', 'the server refused the connection\'s login; reconnect it', { code: 'source.auth' })
            : sourceError('the SFTP server could not be reached', 'sftp.unreachable', true)));
        client.connect({
          sock: socket, username: login.username, readyTimeout: timeoutMs,
          ...(login.password === undefined ? {} : { password: login.password }),
          ...(login.privateKey === undefined ? {} : { privateKey: login.privateKey }),
          ...(login.passphrase === undefined ? {} : { passphrase: login.passphrase }),
          // Checked before authentication: a server with another key never sees the login.
          hostVerifier: (key: Buffer) => {
            const ok = same(hostKeyFingerprint(key), pinned);
            if (!ok) mismatch = true;
            return ok;
          },
        });
      });
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, s) => (error ? reject(sourceError('the server offers no SFTP', 'sftp.unavailable')) : resolve(s))));
      return await use(sftp);
    } finally {
      client.end();
      socket.destroy();
    }
  }

  return {
    async request(caller: Caller, connectionId: string, reason: ConnectionUnwrapReason, operation: Operation): Promise<Reply> {
      const loaded = await deps.credentials.load(caller, connectionId);
      deps.credentials.usable(loaded, reason);
      const { manifest } = loaded;
      if (manifest.protocol.kind !== 'sftp' || manifest.transport.baseUrl === undefined || manifest.transport.viaAgent) {
        throw new AppError('validation', 'this connection is not reached over SFTP from the cell', { code: 'connection.not_sftp' });
      }
      const params = parametersOf(loaded.connection.parameters);
      const pinned = params[SFTP_HOST_KEY_PARAMETER];
      if (pinned === undefined || !HOST_KEY.test(pinned)) {
        throw new AppError('validation', `the connection pins no host key: set ${SFTP_HOST_KEY_PARAMETER} to the server's SHA256 fingerprint`, { code: 'sftp.host_key_missing' });
      }
      const target = sftpTarget(manifest.transport.baseUrl, params);
      const directory = `${target.basePath}/${operation.directory}`;
      const roleOf = new Map(manifest.auth.fields.map((f) => [f.name, f.role]));
      const needed = loaded.rows.filter((r) => r.custody === 'cell' && roleOf.has(r.fieldName));
      return deps.credentials.open(caller, needed, reason, async (values) => {
        const byRole = (role: string) => [...values].find(([name]) => roleOf.get(name) === role)?.[1];
        const username = byRole('username');
        if (username === undefined) throw new AppError('unauthenticated', 'the connection has no username; connect it', { code: 'credential.missing', details: { field: 'username' } });
        const password = byRole('password');
        const login = {
          username: username.toString('utf8'),
          ...(manifest.auth.strategy === 'username_password' && password !== undefined ? { password: password.toString('utf8') } : {}),
          ...(manifest.auth.strategy === 'ssh_key' ? { privateKey: Buffer.from(byRole('private_key') ?? Buffer.alloc(0)), ...(byRole('passphrase') ? { passphrase: Buffer.from(byRole('passphrase')!) } : {}) } : {}),
        };
        const socket = await deps.tcp.connect({ host: target.host, port: target.port, timeoutMs, privateLinks: loaded.privateLinks });
        try {
          return await session(socket, login, pinned, async (sftp) => {
            if (operation.kind === 'list') {
              const entries = await new Promise<{ filename: string; attrs: { size: number; mtime: number; mode: number } }[]>((resolve, reject) =>
                sftp.readdir(directory, (error, list) => (error ? reject(new AppError('not_found', 'the directory is not on the server', { code: 'source.not_found' })) : resolve(list))));
              const files = entries.filter((e) => (e.attrs.mode & 0o170000) === 0o100000);
              if (files.length > SFTP_MAX_LIST_ENTRIES) throw new AppError('bounds', `the directory holds more than ${SFTP_MAX_LIST_ENTRIES} files`, { code: 'sftp.too_many_entries' });
              return { kind: 'list' as const, entries: files.map((e) => ({ name: e.filename, size: e.attrs.size, modifiedAt: new Date(e.attrs.mtime * 1000).toISOString() })) };
            }
            const path = `${directory}/${operation.name}`;
            const size = await new Promise<number>((resolve, reject) =>
              sftp.stat(path, (error, attrs) => (error ? reject(new AppError('not_found', 'the file is not on the server', { code: 'source.not_found' })) : resolve(attrs.size))));
            if (size > operation.maxBytes) {
              throw new AppError('bounds', `the file is larger than ${operation.maxBytes} bytes`, { code: 'sftp.file_too_large', details: { limit: operation.maxBytes } });
            }
            const chunks: Buffer[] = [];
            let read = 0;
            await new Promise<void>((resolve, reject) => {
              const stream = sftp.createReadStream(path);
              stream.on('data', (chunk: Buffer) => {
                read += chunk.length;
                if (read > operation.maxBytes) {
                  stream.destroy();
                  reject(new AppError('bounds', `the file is larger than ${operation.maxBytes} bytes`, { code: 'sftp.file_too_large', details: { limit: operation.maxBytes } }));
                  return;
                }
                chunks.push(chunk);
              });
              stream.once('end', () => resolve());
              stream.once('error', () => reject(sourceError('the file could not be read', 'sftp.read_failed', true)));
            });
            const content = Buffer.concat(chunks);
            return { kind: 'read' as const, size: content.length, contentBase64: content.toString('base64') };
          });
        } finally {
          if (login.privateKey !== undefined) zeroise(login.privateKey);
          if ('passphrase' in login && login.passphrase !== undefined) zeroise(login.passphrase);
          socket.destroy();
        }
      });
    },
  };
}

export type SftpMediator = ReturnType<typeof createSftpMediator>;
