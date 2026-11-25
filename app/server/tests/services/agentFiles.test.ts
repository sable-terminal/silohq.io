// A file share through the built Silo Agent (spec 14.4 "SFTP and file share", 10.4): files in a
// directory on the agent's host, beneath the root its owner allows, listed and read by the agent
// in chunks and parsed by the cell as SFTP's are. A file over its bound is refused, never cut; a
// directory that is not there is named so; nothing outside the allowed root is read.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';
import { hasGo, startAgentSource, type AgentSource } from './agentSource.helper.ts';
import { doc } from './connect.helper.ts';

let source: AgentSource;
let base: string;
let share: string;

const manifestFor = (root: string) => doc({
  schemaVersion: '1', identity: { name: 'Plant exports', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: true, baseUrl: pathToFileURL(root).href }, protocol: { kind: 'file_share' },
  auth: { strategy: 'none', fields: [] },
  objects: [
    {
      name: 'orders', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' }],
      source: { kind: 'file_share', directory: 'exports', pattern: 'orders-*.csv', format: 'csv' },
    },
    { name: 'readings', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }, { name: 'value', type: 'number' }], source: { kind: 'file_share', directory: 'exports', pattern: '*.jsonl', format: 'jsonl', maxFileBytes: 64 } },
    { name: 'missing', identifier: ['id'], fields: [{ name: 'id', type: 'integer' }], source: { kind: 'file_share', directory: 'nowhere', pattern: '*.csv', format: 'csv' } },
    { name: 'escape', identifier: ['token'], fields: [{ name: 'token', type: 'string' }], source: { kind: 'file_share', directory: 'exports', pattern: 'secret*.csv', format: 'csv' } },
  ],
});

describe('a file share through the Silo Agent (spec 14.4, 10.4)', { skip: !hasGo }, () => {
  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'silo-share-'));
    share = path.join(base, 'share');
    await mkdir(path.join(share, 'exports'), { recursive: true });
    await mkdir(path.join(base, 'private'));
    await writeFile(path.join(share, 'exports', 'orders-1.csv'), 'id,region,amount\n1,north,10.5\n2,south,20\n');
    await writeFile(path.join(share, 'exports', 'orders-2.csv'), 'id,region,amount\n3,east,\n');
    await writeFile(path.join(share, 'exports', 'readings.jsonl'), `${'{"id":1,"value":0.5}\n'.repeat(10)}`);
    await writeFile(path.join(base, 'private', 'secret.csv'), 'token\nxyz\n');
    // A link inside the share to a file outside it: listed by no one, read by no one.
    await symlink(path.join(base, 'private', 'secret.csv'), path.join(share, 'exports', 'secret.csv'));
    source = await startAgentSource({ dialect: 'files', manifest: manifestFor(share), custodies: ['cell'], agentConfig: { fileRoots: [share] } });
  });

  after(async () => {
    await source?.close();
    if (base) await rm(base, { recursive: true, force: true });
  });

  test('the files matching the pattern, read in name order through the agent and parsed by the cell', async () => {
    const out = await source.read(source.cellHeld, { object: 'orders', fields: ['id', 'region', 'amount'], filters: [], sort: [{ field: 'id', direction: 'asc' }] });
    assert.deepEqual((out as { rows: unknown[] }).rows, [
      { id: 1, region: 'north', amount: 10.5 }, { id: 2, region: 'south', amount: 20 }, { id: 3, region: 'east', amount: null },
    ]);
  });

  test('a file over its bound is refused, never cut; a directory that is not there is named; a link leaving the share reads nothing', async () => {
    await assert.rejects(source.read(source.cellHeld, { object: 'readings', fields: ['id', 'value'], filters: [], sort: [] }), { code: 'sftp.file_too_large' });
    await assert.rejects(source.read(source.cellHeld, { object: 'missing', fields: ['id'], filters: [], sort: [] }), { code: 'files.not_found' });
    const escaped = await source.read(source.cellHeld, { object: 'escape', fields: ['token'], filters: [], sort: [] });
    assert.deepEqual((escaped as { rows: unknown[] }).rows, [], 'the link out of the share is not listed');
  });

  test('a file share is the agent\'s, with a file:/// root and no login', () => {
    const bad = (patch: Record<string, unknown>) => manifestSchema.safeParse({ ...manifestFor(share), ...patch }).success;
    assert.equal(bad({ transport: { viaAgent: false, baseUrl: pathToFileURL(share).href } }), false, 'read by the agent');
    assert.equal(bad({ transport: { viaAgent: true, baseUrl: 'https://files.example.com' } }), false, 'a file:/// root');
    assert.equal(bad({ auth: { strategy: 'basic', fields: [{ name: 'u', kind: 'public', label: 'U', role: 'username' }, { name: 'p', kind: 'secret', label: 'P', role: 'password' }] } }), false, 'no login');
  });
});
