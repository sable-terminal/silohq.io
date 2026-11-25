// Object storage and BigQuery (spec 8.1): object-files (exports, uploads, logos,
// avatars), object-backup (database backups, audit archive), gcs-siloes (Import source
// files) and bq-siloes (Import rows). Google Cloud Storage in commercial cells; any
// S3-compatible store for self-managed installs (design: deployment modes). BigQuery and
// GCS are compiled out of the sovereign build (spec 6.5).

import { z } from 'zod';
import { parseSection, read, readSecret, zBool, type Env } from './env.config.ts';

const bucket = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/, 'must be a bucket name');

const schema = z.object({
  provider: z.enum(['gcs', 's3']),
  filesBucket: bucket.optional(),
  backupBucket: bucket.optional(),
  siloesBucket: bucket.optional(),
  /** The basemap's PMTiles archive (decision 2026-11-14): no third-party tile calls. */
  tilesBucket: bucket.optional(),
  s3Endpoint: z.url().optional(),
  s3Region: z.string().default('eu-west-2'),
  s3ForcePathStyle: zBool.default(false),
  s3AccessKeyId: z.string().optional(),
  s3SecretAccessKey: z.string().optional(),
  // fake-gcs-server, for development and tests only; production refuses it (index.config).
  // Not STORAGE_EMULATOR_HOST: the client library uses that one inconsistently, and
  // either JSON calls or uploads miss the emulator.
  gcsEmulatorEndpoint: z.url().optional(),
});

const bigQuerySchema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'must be a GCP project id'),
  location: z.string().min(2),
});

export type ObjectStorageConfig = z.output<typeof schema>;
export type BigQueryConfig = z.output<typeof bigQuerySchema>;

export function loadObjectStorageConfig(env: Env, problems: string[]): ObjectStorageConfig | undefined {
  if (read(env, 'OBJECT_STORE') === undefined) return undefined;
  const parsed = parseSection(schema, {
    provider: read(env, 'OBJECT_STORE'),
    filesBucket: read(env, 'OBJECT_BUCKET_FILES'),
    backupBucket: read(env, 'OBJECT_BUCKET_BACKUP'),
    siloesBucket: read(env, 'OBJECT_BUCKET_SILOES'),
    tilesBucket: read(env, 'OBJECT_BUCKET_TILES'),
    s3Endpoint: read(env, 'S3_ENDPOINT'),
    s3Region: read(env, 'S3_REGION'),
    s3ForcePathStyle: read(env, 'S3_FORCE_PATH_STYLE'),
    s3AccessKeyId: read(env, 'S3_ACCESS_KEY_ID'),
    s3SecretAccessKey: readSecret(env, 'S3_SECRET_ACCESS_KEY', problems),
    gcsEmulatorEndpoint: read(env, 'GCS_EMULATOR_ENDPOINT'),
  }, {
    provider: 'OBJECT_STORE', filesBucket: 'OBJECT_BUCKET_FILES', backupBucket: 'OBJECT_BUCKET_BACKUP',
    siloesBucket: 'OBJECT_BUCKET_SILOES', tilesBucket: 'OBJECT_BUCKET_TILES', s3Endpoint: 'S3_ENDPOINT', s3Region: 'S3_REGION',
    s3ForcePathStyle: 'S3_FORCE_PATH_STYLE', s3AccessKeyId: 'S3_ACCESS_KEY_ID', s3SecretAccessKey: 'S3_SECRET_ACCESS_KEY',
    gcsEmulatorEndpoint: 'GCS_EMULATOR_ENDPOINT',
  }, problems);
  if (parsed?.gcsEmulatorEndpoint !== undefined && parsed.provider !== 'gcs') {
    problems.push('GCS_EMULATOR_ENDPOINT: only for OBJECT_STORE=gcs');
  }
  if (parsed && (parsed.s3AccessKeyId === undefined) !== (parsed.s3SecretAccessKey === undefined)) {
    problems.push('S3_ACCESS_KEY_ID: set with S3_SECRET_ACCESS_KEY, or neither to use the workload identity');
  }
  return parsed;
}

export function loadBigQueryConfig(env: Env, problems: string[]): BigQueryConfig | undefined {
  if (read(env, 'BIGQUERY_PROJECT_ID') === undefined && read(env, 'BIGQUERY_LOCATION') === undefined) return undefined;
  return parseSection(bigQuerySchema, {
    projectId: read(env, 'BIGQUERY_PROJECT_ID'),
    location: read(env, 'BIGQUERY_LOCATION'),
  }, { projectId: 'BIGQUERY_PROJECT_ID', location: 'BIGQUERY_LOCATION' }, problems);
}
