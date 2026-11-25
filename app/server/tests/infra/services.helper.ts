// Where the infra tests find the local containers (docker-compose.yml, npm run infra:up).

import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

export const LOCAL = {
  pgbouncerHost: process.env['TEST_PGBOUNCER_HOST'] ?? '127.0.0.1:56432',
  redisUrl: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:56379',
  natsUrl: process.env['TEST_NATS_URL'] ?? 'nats://127.0.0.1:54222',
  vaultAddr: process.env['TEST_VAULT_ADDR'] ?? 'http://127.0.0.1:58200',
  vaultToken: process.env['TEST_VAULT_TOKEN'] ?? 'dev-root',
  s3Endpoint: process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:58333',
  // The Pub/Sub client reads PUBSUB_EMULATOR_HOST itself; the GCS adapter takes
  // GCS_EMULATOR_ENDPOINT from configuration.
  pubsubEmulatorHost: process.env['TEST_PUBSUB_EMULATOR_HOST'] ?? '127.0.0.1:58085',
  gcsEmulatorEndpoint: process.env['TEST_GCS_EMULATOR_ENDPOINT'] ?? 'http://127.0.0.1:54443',
  gcpProjectId: 'silo-local',
};

/**
 * A test's bucket goes when the test does: SeaweedFS gives each bucket its own volumes, so
 * buckets left behind run a long-lived container out of them ("No writable volumes").
 */
export async function dropTestBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    for (;;) {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key === undefined ? [] : [{ Key: o.Key }]));
      if (keys.length === 0) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    // Cleanup never fails the test it follows; a bucket left behind is named so it can be found.
    console.warn(`test bucket ${bucket} was not removed: ${(error as Error).message}`);
  }
}
