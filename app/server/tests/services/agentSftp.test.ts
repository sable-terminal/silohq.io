// SFTP through the built Silo Agent (spec 14.4, 10.4): a server on the customer's network, the
// connection's login kept in the cell and sealed to the agent for each piece of work, the host
// pinned by its key, the files read by the agent in chunks and parsed by the cell as any SFTP
// connection's. A server presenting another key is refused before the login is sent. The server
// here is ssh2's own, in process; the agent is the real binary.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ssh2, { type Connection, type ParsedKey, type Server } from 'ssh2';
import { hostKeyFingerprint } from '../../src/services/credential/sftp.service.ts';
import { hasGo, startAgentSource, type AgentSource } from './agentSource.helper.ts';
import { doc } from './connect.helper.ts';

const { utils } = ssh2;
let server: Server;
let port = 0;
let pinned = '';
let source: AgentSource;
const FILES: Record<string, string> = { '/exports/daily/orders-2026-11-01.csv': 'order_id,customer,total\nO-1,Acme,12.50\nO-2,Brill,30\n' };
const DIRECTORIES = new Set(['/exports/daily']);

function serve(client: Connection): void {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'silo' && ctx.password === 'sftp-secret' ? ctx.accept() : ctx.reject(['password'])))
    .on('ready', () => {
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const { STATUS_CODE } = utils.sftp;
          const handles = new Map<string, { path: string; listed?: boolean }>();
          let next = 0;
          const attrsOf = (path: string) => ({ mode: DIRECTORIES.has(path) ? 0o040755 : 0o100644, size: Buffer.byteLength(FILES[path] ?? ''), uid: 0, gid: 0, atime: 1_762_000_000, mtime: 1_762_000_000 });
          const handle = (path: string, listed?: boolean) => {
            const id = Buffer.from(String(next++));
            handles.set(id.toString(), { path, ...(listed === undefined ? {} : { listed }) });
            return id;
          };
          sftp.on('OPENDIR', (reqid, path) => (DIRECTORIES.has(path) ? sftp.handle(reqid, handle(path, false)) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)));
          sftp.on('READDIR', (reqid, h) => {
            const open = handles.get(h.toString());
            if (open === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (open.listed) return sftp.status(reqid, STATUS_CODE.EOF);
            open.listed = true;
            const names = Object.keys(FILES).filter((p) => p.startsWith(`${open.path}/`)).map((p) => p.slice(open.path.length + 1));
            return sftp.name(reqid, names.map((filename) => ({ filename, longname: filename, attrs: attrsOf(`${open.path}/${filename}`) })));
          });
          const stat = (reqid: number, path: string) => (FILES[path] !== undefined || DIRECTORIES.has(path) ? sftp.attrs(reqid, attrsOf(path)) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
          sftp.on('STAT', stat);
          sftp.on('LSTAT', stat);
          sftp.on('FSTAT', (reqid, h) => stat(reqid, handles.get(h.toString())?.path ?? ''));
          sftp.on('OPEN', (reqid, filename) => (FILES[filename] === undefined ? sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) : sftp.handle(reqid, handle(filename))));
          sftp.on('READ', (reqid, h, offset, length) => {
            const content = Buffer.from(FILES[handles.get(h.toString())?.path ?? ''] ?? '');
            if (offset >= content.length) return sftp.status(reqid, STATUS_CODE.EOF);
            return sftp.data(reqid, content.subarray(offset, offset + length));
          });
          sftp.on('CLOSE', (reqid, h) => {
            handles.delete(h.toString());
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    }).on('error', () => undefined);
}

const manifestFor = (at: number) => doc({
  schemaVersion: '1', identity: { name: 'Nightly exports', provider: 'Example ERP', version: '1.0.0' },
  transport: { viaAgent: true, baseUrl: `sftp://127.0.0.1:${at}/exports` }, protocol: { kind: 'sftp' },
  params: [{ name: 'host_key_sha256', label: 'Server host key (SHA256)', required: true }],
  auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  objects: [{
    name: 'orders', identifier: ['id'],
    fields: [{ name: 'id', type: 'string', path: 'order_id' }, { name: 'customer', type: 'string' }, { name: 'total', type: 'number' }],
    source: { kind: 'sftp', directory: 'daily', pattern: 'orders-*.csv', format: 'csv' },
  }],
});

describe('SFTP through the Silo Agent (spec 14.4, 10.4)', { skip: !hasGo }, () => {
  before(async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    pinned = hostKeyFingerprint((utils.parseKey(hostKey.public) as ParsedKey).getPublicSSH());
    server = new ssh2.Server({ hostKeys: [hostKey.private] }, serve);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    source = await startAgentSource({
      dialect: 'sftp', manifest: manifestFor(port), custodies: ['cell'], cellParameters: { host_key_sha256: pinned },
      login: { username: 'silo', password: 'sftp-secret' },
    });
  });

  after(async () => {
    await source?.close();
    server?.close();
  });

  test('the files, read by the agent with the cell\'s login sealed to it, pinned, parsed by the cell', async () => {
    const out = await source.read(source.cellHeld, { object: 'orders', fields: ['id', 'customer', 'total'], filters: [], sort: [{ field: 'id', direction: 'asc' }] });
    assert.deepEqual((out as { rows: unknown[] }).rows, [{ id: 'O-1', customer: 'Acme', total: 12.5 }, { id: 'O-2', customer: 'Brill', total: 30 }]);
  });

  // A server presenting another key than the pinned one is refused before the login is offered: agent/internal/work TestSFTP.
  test('a wrong password is the server\'s refusal of the login, said as such', async () => {
    await source.setPassword(source.cellHeld, 'not-it');
    await assert.rejects(source.read(source.cellHeld, { object: 'orders', fields: ['id'], filters: [], sort: [] }), { code: 'source.auth' });
    await source.setPassword(source.cellHeld, 'sftp-secret');
  });
});
