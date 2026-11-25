// Object storage through both adapters: S3-compatible (self-managed installs, against
// SeaweedFS) and Google Cloud Storage (commercial cells, against fake-gcs-server).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { createObjectStore, objectKey, type ObjectStore } from '../../src/infra/objectStorage.infra.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { dropTestBucket, LOCAL } from './services.helper.ts';

const credentials = { accessKeyId: 'local', secretAccessKey: 'local-secret' };

// The cell template creates the buckets, private; here the test does, and removes the S3 one after.
const admin = new S3Client({ endpoint: LOCAL.s3Endpoint, region: 'eu-west-2', forcePathStyle: true, credentials });
const s3Bucket = `silo-files-${Date.now().toString(36)}`;
after(async () => {
  await dropTestBucket(admin, s3Bucket);
  admin.destroy();
});
const stores: [string, () => Promise<ObjectStore>][] = [
  ['s3', async () => {
    const bucket = s3Bucket;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    return createObjectStore({
      provider: 's3', filesBucket: bucket, s3Endpoint: LOCAL.s3Endpoint, s3Region: 'eu-west-2', s3ForcePathStyle: true,
      s3AccessKeyId: credentials.accessKeyId, s3SecretAccessKey: credentials.secretAccessKey,
    });
  }],
  ['gcs', async () => {
    const bucket = `silo-files-${Date.now().toString(36)}`;
    await new Storage({ projectId: LOCAL.gcpProjectId, apiEndpoint: LOCAL.gcsEmulatorEndpoint }).createBucket(bucket);
    return createObjectStore({
      provider: 'gcs', filesBucket: bucket, gcsEmulatorEndpoint: LOCAL.gcsEmulatorEndpoint, s3Region: 'eu-west-2', s3ForcePathStyle: false,
    });
  }],
];

describe('object keys', () => {
  test('are partitioned by organisation and never carry a path escape', () => {
    const org = uuidv7();
    assert.equal(objectKey.organisation(org, 'exports', 'e1.csv'), `org/${org}/exports/e1.csv`);
    assert.throws(() => objectKey.organisation(org, '..', 'other'), TypeError);
    assert.throws(() => objectKey.organisation(org, 'a/b'), TypeError);
    assert.throws(() => objectKey.organisation('acme', 'x'), TypeError);
  });
});

for (const [name, make] of stores) {
  describe(`object storage: ${name}`, () => {
    let store: ObjectStore;
    before(async () => {
      store = await make();
    });

    test('puts, reads, describes and deletes an object', async () => {
      const key = objectKey.organisation(uuidv7(), 'exports', `${uuidv7()}.csv`);
      await store.put('files', key, Buffer.from('a,b\n1,2\n'), 'text/csv');
      assert.equal((await store.get('files', key)).toString(), 'a,b\n1,2\n');
      assert.deepEqual(await store.head('files', key), { bytes: 8, contentType: 'text/csv' });
      await store.delete('files', key);
      assert.equal(await store.head('files', key), undefined);
      await assert.rejects(store.get('files', key), { category: 'not_found' });
      // Deleting what is gone is not an error.
      await store.delete('files', key);
    });

    test('reads a range of an object, and lists everything an organisation holds', async () => {
      const organisationId = uuidv7();
      const key = objectKey.organisation(organisationId, 'exports', uuidv7(), 'bundle.tar.gz');
      await store.put('files', key, Buffer.from('0123456789'), 'application/gzip');
      assert.equal((await store.getRange('files', key, 2, 5)).toString(), '2345');
      await store.put('files', objectKey.organisation(organisationId, 'files', uuidv7()), Buffer.from('x'), 'text/plain');
      const listed = await store.list('files', objectKey.organisationFolder(organisationId), 100);
      assert.equal(listed.length, 2);
      assert.ok(listed.every((k) => k.startsWith(`org/${organisationId}/`)));
    });

    test('writes an object as a stream: in parts above the multipart size, whole below it, nothing when abandoned', async () => {
      const organisationId = uuidv7();
      // Above S3's 16 MiB part, so the S3 adapter sends two parts.
      const big = randomBytes(17 * 1024 * 1024 + 321);
      const key = objectKey.organisation(organisationId, 'files', uuidv7());
      const upload = await store.openUpload('files', key, 'application/octet-stream');
      for (let at = 0; at < big.length; at += 1024 * 1024) await upload.write(big.subarray(at, Math.min(big.length, at + 1024 * 1024)));
      assert.deepEqual(await upload.finish(), { bytes: big.length });
      assert.deepEqual(await store.head('files', key), { bytes: big.length, contentType: 'application/octet-stream' });
      assert.ok((await store.getRange('files', key, 16 * 1024 * 1024 - 10, 16 * 1024 * 1024 + 9)).equals(big.subarray(16 * 1024 * 1024 - 10, 16 * 1024 * 1024 + 10)));
      assert.ok((await store.get('files', key)).equals(big));

      const small = objectKey.organisation(organisationId, 'files', uuidv7());
      const one = await store.openUpload('files', small, 'text/plain');
      await one.write(Buffer.from('a small '));
      await one.write(Buffer.from('object'));
      await one.finish();
      assert.equal((await store.get('files', small)).toString(), 'a small object');

      const dropped = objectKey.organisation(organisationId, 'files', uuidv7());
      const abandoned = await store.openUpload('files', dropped, 'text/plain');
      await abandoned.write(Buffer.from('never finished'));
      await abandoned.abort();
      assert.equal(await store.head('files', dropped), undefined, 'an abandoned upload leaves nothing at the key');
    });

    test('an unconfigured bucket is a configuration error', async () => {
      await assert.rejects(store.openUpload('backup', objectKey.cell('x'), 'text/plain'), { category: 'configuration' });
      await assert.rejects(store.put('backup', objectKey.cell('x'), Buffer.from(''), 'text/plain'), { category: 'configuration' });
    });
  });
}
