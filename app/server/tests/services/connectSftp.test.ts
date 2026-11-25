// SFTP connections end to end (spec 14.4 "SFTP and file share"): the credential service runs
// the SSH session beside the login, pinned to the server's host key, and the cell parses the
// files: CSV by its header, JSON Lines by the fields' paths, in name order, bounded. The
// server here is ssh2's own, in process. Real processes: credential, policy, auth,
// connect-registry, connect-runtime.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ssh2, { type Connection, type ParsedKey, type Server } from 'ssh2';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { hostKeyFingerprint } from '../../src/services/credential/sftp.service.ts';
import { patternMatcher } from '../../src/services/connect-runtime/protocols/sftp/sftp.protocol.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const { utils } = ssh2;
let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let server: Server;
let port: number;
let pinned: string;
const clientKey = utils.generateKeyPairSync('ed25519');
const allowedKey = utils.parseKey(clientKey.public) as ParsedKey;
let logins = 0;

const FILES: Record<string, string> = {
  '/exports/daily/orders-2026-11-02.csv': 'order_id,customer,total,placed_on\nO-3,Brill,7.25,2026-11-02\n',
  '/exports/daily/orders-2026-11-01.csv': 'order_id,customer,total,placed_on\nO-1,"Acme, Ltd",12.50,2026-11-01\nO-2,,30,2026-11-01\n',
  '/exports/daily/notes.txt': 'not an order',
  '/exports/feed/events.jsonl': '{"id":"e1","kind":"start","at":{"t":"2026-11-03T09:00:00Z"}}\n\n{"id":"e2","kind":"stop","at":{"t":"2026-11-03T10:00:00Z"}}\n',
};
const DIRECTORIES = new Set(['/exports/daily', '/exports/feed']);

function serveSftp(client: Connection): void {
  client.on('authentication', (ctx) => {
    logins += 1;
    if (ctx.username !== 'silo') return ctx.reject();
    if (ctx.method === 'password' && ctx.password === 'sftp-secret') return ctx.accept();
    if (ctx.method === 'publickey' && ctx.key.algo === allowedKey.type && ctx.key.data.equals(allowedKey.getPublicSSH())) {
      if (ctx.signature === undefined) return ctx.accept();
      return allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
    }
    return ctx.reject(['password', 'publickey']);
  }).on('ready', () => {
    client.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        const { STATUS_CODE } = utils.sftp;
        const handles = new Map<string, { path: string; listed?: boolean }>();
        let next = 0;
        const attrsOf = (path: string) => ({
          mode: DIRECTORIES.has(path) ? 0o040755 : 0o100644, size: FILES[path] === undefined ? 0 : Buffer.byteLength(FILES[path]!),
          uid: 0, gid: 0, atime: 1_762_000_000, mtime: 1_762_000_000,
        });
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
          const entries = [...names, ...(open.path === '/exports/daily' ? ['archive'] : [])].map((filename) => ({
            filename, longname: filename, attrs: filename === 'archive' ? { ...attrsOf('/exports/daily'), mode: 0o040755 } : attrsOf(`${open.path}/${filename}`),
          }));
          return sftp.name(reqid, entries);
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

before(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519');
  pinned = hostKeyFingerprint((utils.parseKey(hostKey.public) as ParsedKey).getPublicSSH());
  server = new ssh2.Server({ hostKeys: [hostKey.private] }, serveSftp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  server?.close();
});

const LOGIN = {
  password: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
  key: { strategy: 'ssh_key', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'private_key', kind: 'secret', label: 'Key', role: 'private_key' }] },
};

function manifest(options: { login?: keyof typeof LOGIN; maxFiles?: number; pin?: boolean } = {}) {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Nightly exports', provider: 'Example ERP', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl: `sftp://127.0.0.1:${port}/exports` },
    protocol: { kind: 'sftp' },
    params: options.pin === false ? [] : [{ name: 'host_key_sha256', label: 'Server host key (SHA256)', required: true }],
    auth: LOGIN[options.login ?? 'password'],
    objects: [
      {
        name: 'orders', identifier: ['id'],
        fields: [
          { name: 'id', type: 'string', path: 'order_id' }, { name: 'customer', type: 'string' }, { name: 'total', type: 'number' },
          { name: 'placed_on', type: 'date' },
        ],
        source: { kind: 'sftp', directory: 'daily', pattern: 'orders-*.csv', format: 'csv', ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }) },
      },
      {
        name: 'events', identifier: ['id'],
        fields: [{ name: 'id', type: 'string' }, { name: 'kind', type: 'string' }, { name: 'at', type: 'date-time', path: 'at.t' }],
        source: { kind: 'sftp', directory: 'feed', pattern: '*.jsonl', format: 'jsonl' },
      },
    ],
  });
}

async function connection(document: Record<string, never>, secrets: Record<string, string>, hostKey = pinned): Promise<string> {
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const connector = await gateway.call(createConnector, { body: { slug: `sftp-${uuidv7().slice(-12)}`, name: 'Exports', provider: 'Example ERP', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed());
  const created = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Exports', owningScopeId: cell.scopes['engineering']!, parameters: { host_key_sha256: hostKey } },
  }, keyed());
  await gateway.call(setConnectionSecrets, { params: { connectionId: created.id }, body: { values: secrets } }, cell.as(root));
  await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move: 'probe', version: created.version } }, cell.as(root));
  return created.id;
}

const read = (connectionId: string, object: string) =>
  cell.client('executor').call(readObject, { body: { connectionId, reason: 'probe', step: { object } as never } }, cell.as(root));

describe('the SFTP engine (spec 14.4)', () => {
  test('file names match a whole pattern: * a run, ? one character, nothing else special', () => {
    const match = patternMatcher('orders-202?-*.csv');
    assert.deepEqual(['orders-2026-11.csv', 'orders-2026-11.csvx', 'xorders-2026-1.csv', 'orders-2026-.csv'].map(match), [true, false, false, true]);
    assert.equal(patternMatcher('a.b')('axb'), false, 'a dot is a dot');
  });

  test('CSV by its header, in file name order, an empty cell null; files the pattern does not name, and directories, are not read', async () => {
    const id = await connection(manifest(), { username: 'silo', password: 'sftp-secret' });
    const out = await read(id, 'orders');
    assert.deepEqual(out.rows, [
      { id: 'O-1', customer: 'Acme, Ltd', total: 12.5, placed_on: '2026-11-01' },
      { id: 'O-2', customer: null, total: 30, placed_on: '2026-11-01' },
      { id: 'O-3', customer: 'Brill', total: 7.25, placed_on: '2026-11-02' },
    ]);
    const { rows } = await cell.migrate.query(
      `select u.reason, u.calling_service from iam.credential_unwraps u join connect.connection_credentials c on c.id = u.connection_credential_id
       where c.connection_id = $1`, [id]);
    assert.ok(rows.length > 0 && rows.every((r) => r.calling_service === 'connect-runtime'), 'every use of the login is on the ledger');
  });

  test('JSON Lines by the fields\' paths, logging in with a private key', async () => {
    const id = await connection(manifest({ login: 'key' }), { username: 'silo', private_key: clientKey.private });
    const out = await read(id, 'events');
    assert.deepEqual(out.rows, [{ id: 'e1', kind: 'start', at: '2026-11-03T09:00:00Z' }, { id: 'e2', kind: 'stop', at: '2026-11-03T10:00:00Z' }]);
  });

  test('a server presenting another host key is refused before the login is sent', async () => {
    const id = await connection(manifest(), { username: 'silo', password: 'sftp-secret' }, `SHA256:${'A'.repeat(43)}`);
    const before = logins;
    await assert.rejects(read(id, 'orders'), { code: 'sftp.host_key_mismatch' });
    assert.equal(logins, before, 'the server never saw an authentication attempt');
  });

  test('more files than declared are refused, never truncated; a wrong password is an auth refusal', async () => {
    const bounded = await connection(manifest({ maxFiles: 1 }), { username: 'silo', password: 'sftp-secret' });
    await assert.rejects(read(bounded, 'orders'), { code: 'sftp.too_many_files' });
    const wrong = await connection(manifest(), { username: 'silo', password: 'not-it' });
    await assert.rejects(read(wrong, 'orders'), { code: 'source.auth' });
  });

  test('an SFTP manifest pins its server and logs in as SSH does; it writes nothing', async () => {
    const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
    const connector = await gateway.call(createConnector, { body: { slug: `sftp-${uuidv7().slice(-12)}`, name: 'Exports', provider: 'Example ERP', sourceRoute: 'visual' } }, keyed());
    const save = (document: Record<string, never>) => gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed());
    await assert.rejects(save(manifest({ pin: false })), { category: 'validation' });
    const writes = manifest() as unknown as { objects: Record<string, unknown>[] };
    writes.objects[0]!['writes'] = { create: { request: { method: 'POST', path: '/x' } } };
    await assert.rejects(save(writes as unknown as Record<string, never>), { category: 'validation' });
  });
});
