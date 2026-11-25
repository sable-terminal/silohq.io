// The formats an exit export and a tenant migration are written in: sealing to another
// cell's import key (spec 6.4), the bundle's tar (spec 2.6) and Parquet (spec 2.6, Siloes).

import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { parquetReadObjects } from 'hyparquet';
import {
  canonicalImportKey, importKeyId, openX25519, rsaCiphertext, sealedScheme, sealToImportKey, x25519FromSeed,
} from '../../src/utils/importKey.util.ts';
import { rowsToParquet } from '../../src/utils/parquet.util.ts';
import { createTarGzipWriter, readTar, tarGzip } from '../../src/utils/tar.util.ts';

describe('sealing to an import key', () => {
  test('RSA-OAEP with SHA-256, as Cloud KMS and Vault open it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const secret = randomBytes(32);
    const sealed = sealToImportKey(pem, secret);
    assert.equal(sealedScheme(sealed), 'rsa_oaep_sha256');
    assert.deepEqual(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, rsaCiphertext(sealed)), secret);
    assert.match(importKeyId(pem), /^[0-9a-f]{64}$/);
    assert.equal(importKeyId(canonicalImportKey(pem)), importKeyId(pem));
  });

  test('X25519, as the local provider opens it; another key cannot', () => {
    const mine = x25519FromSeed(randomBytes(32));
    const secret = randomBytes(32);
    assert.deepEqual(openX25519(mine.privateKey, sealToImportKey(mine.publicKeyPem, secret)), secret);
    const other = x25519FromSeed(randomBytes(32));
    assert.throws(() => openX25519(other.privateKey, sealToImportKey(mine.publicKeyPem, secret)), { category: 'integrity' });
  });

  test('refuses a key too weak or of the wrong kind', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.throws(() => sealToImportKey(weak, randomBytes(32)), { code: 'import_key.invalid' });
    const signing = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.throws(() => sealToImportKey(signing, randomBytes(32)), { code: 'import_key.invalid' });
  });
});

describe('the export bundle', () => {
  test('a gzipped ustar that reads back, long paths split at a slash', () => {
    const long = `siloes/${'a'.repeat(60)}/files/${'b'.repeat(40)}/${'c'.repeat(60)}.csv`;
    const files = [{ path: 'manifest.json', body: Buffer.from('{}') }, { path: long, body: randomBytes(1_500) }, { path: 'empty.txt', body: Buffer.alloc(0) }];
    const archive = gunzipSync(tarGzip(files, new Date('2026-11-04T00:00:00Z')));
    assert.equal(archive.length % 512, 0);
    assert.deepEqual(readTar(archive), files);
  });

  test('written as it goes, it reads back the same, and its checksum is of the bytes written', async () => {
    const long = `siloes/${'a'.repeat(60)}/files/${'b'.repeat(40)}/${'c'.repeat(60)}.csv`;
    const files = [{ path: long, body: randomBytes(70_001) }, { path: 'empty.txt', body: Buffer.alloc(0) }, { path: 'manifest.json', body: Buffer.from('{}') }];
    const chunks: Buffer[] = [];
    const writer = createTarGzipWriter({ async write(chunk) { chunks.push(chunk); } }, new Date('2026-11-04T00:00:00Z'));
    for (const f of files) await writer.add(f.path, f.body);
    const written = await writer.finish();
    const archive = Buffer.concat(chunks);
    assert.equal(written.bytes, archive.length);
    assert.deepEqual(written.sha256, createHash('sha256').update(archive).digest());
    assert.deepEqual(readTar(gunzipSync(archive)), files, 'every gzip member is read as one stream');
    assert.deepEqual(gunzipSync(archive), gunzipSync(tarGzip(files, new Date('2026-11-04T00:00:00Z'))), 'the same tar as one built in memory');
  });

  test('Parquet that a reader reads back, column by column', async () => {
    const rows = [
      { object_ref: 'a-1', amount: 12.5, active: true, detail: { k: 1 } },
      { object_ref: 'a-2', amount: null, active: false, detail: null },
    ];
    const buffer = rowsToParquet(rows);
    const read = await parquetReadObjects({ file: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) as ArrayBuffer });
    assert.deepEqual(read, [
      { object_ref: 'a-1', amount: 12.5, active: true, detail: '{"k":1}' },
      { object_ref: 'a-2', amount: null, active: false, detail: null },
    ]);
  });
});
