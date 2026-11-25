// Object storage (spec 8.1): object-files (exports, uploads, logos, avatars),
// object-backup (database backups, audit archive) and gcs-siloes (Import source files).
// Google Cloud Storage in commercial cells; any S3-compatible store in self-managed
// installs. Never public: buckets are created private by the cell template, and this
// adapter has no way to make an object public.
//
// "Object storage paths ... are partitioned by organisation id" (spec 64.5): tenant
// objects are addressed only through objectKey, which puts the organisation first. The
// key never contains a filename (siloes.silo_files.object_store_key).

import type { ObjectStorageConfig } from '../config/storage.config.ts';
import { AppError } from '../utils/errors.util.ts';
import { isUuid } from '../utils/id.util.ts';

export type Bucket = 'files' | 'backup' | 'siloes' | 'tiles';

declare const objectKeyBrand: unique symbol;
export type ObjectKey = string & { readonly [objectKeyBrand]: true };

const PART = /^[A-Za-z0-9_.-]{1,200}$/;

export const objectKey = {
  /** org/<organisation_id>/<parts>. Every tenant object. */
  organisation(organisationId: string, ...parts: string[]): ObjectKey {
    if (!isUuid(organisationId)) throw new TypeError('organisation id must be a UUID');
    if (parts.length === 0 || parts.some((p) => !PART.test(p) || p === '.' || p === '..')) {
      throw new TypeError('an object key part must be an identifier');
    }
    return `org/${organisationId}/${parts.join('/')}` as ObjectKey;
  },
  /** org/<organisation_id>, the prefix to list everything an organisation holds (a tenant migration moves it all). */
  organisationFolder(organisationId: string): ObjectKey {
    if (!isUuid(organisationId)) throw new TypeError('organisation id must be a UUID');
    return `org/${organisationId}` as ObjectKey;
  },
  /** The basemap archive in the tiles bucket (decision 2026-11-14): a path of identifier parts, ending .pmtiles. */
  basemap(path: string): ObjectKey {
    const parts = path.split('/');
    if (!path.endsWith('.pmtiles') || parts.some((p) => !PART.test(p) || p === '.' || p === '..')) {
      throw new TypeError('a basemap key is a path of identifier parts ending .pmtiles');
    }
    return path as ObjectKey;
  },
  /**
   * agent-binaries/<sha256 hex>, in object-files: a Silo Agent binary Fleet released, held by
   * the digest of its bytes for the cell's agents to download (spec 10.7). Silo's software, not tenant data.
   */
  agentBinary(hex: string): ObjectKey {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('an agent binary is keyed by its SHA-256, 64 lowercase hex');
    return `agent-binaries/${hex}` as ObjectKey;
  },
  /** cell/<parts>. Cell-level objects in object-backup only (backups, the audit archive). */
  cell(...parts: string[]): ObjectKey {
    if (parts.length === 0 || parts.some((p) => !PART.test(p) || p === '.' || p === '..')) {
      throw new TypeError('an object key part must be an identifier');
    }
    return `cell/${parts.join('/')}` as ObjectKey;
  },
};

export interface ObjectHead {
  bytes: number;
  contentType: string | undefined;
}

/**
 * One object written in pieces, for an object too large to hold (a tenant migration bundle).
 * The object is whole at the key once finish() succeeds; abort() leaves nothing there.
 */
export interface ObjectUpload {
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<{ bytes: number }>;
  abort(): Promise<void>;
}

export interface ObjectStore {
  put(bucket: Bucket, key: ObjectKey, body: Buffer, contentType: string): Promise<void>;
  /** An object written as a stream: a GCS resumable upload, or an S3 multipart upload. */
  openUpload(bucket: Bucket, key: ObjectKey, contentType: string): Promise<ObjectUpload>;
  get(bucket: Bucket, key: ObjectKey): Promise<Buffer>;
  /** Bytes start to end inclusive, for a large object read in parts. */
  getRange(bucket: Bucket, key: ObjectKey, start: number, end: number): Promise<Buffer>;
  head(bucket: Bucket, key: ObjectKey): Promise<ObjectHead | undefined>;
  delete(bucket: Bucket, key: ObjectKey): Promise<void>;
  /** Every version of an object, live and noncurrent: a purge leaves no generation behind (spec 70.2). */
  purge(bucket: Bucket, key: ObjectKey): Promise<{ versions: number }>;
  /** Keys under a prefix (an organisation's folder), oldest listing order, at most limit. */
  list(bucket: Bucket, prefix: ObjectKey, limit: number): Promise<ObjectKey[]>;
  /**
   * A signed, short-lived URL a client starts a resumable upload of one object with, at most
   * maxBytes: absent where the store cannot sign one (the S3 adapter, for now).
   */
  signUpload?(bucket: Bucket, key: ObjectKey, options: { contentType: string; maxBytes: number; expiresInSeconds: number }): Promise<SignedUpload>;
  /** A signed, short-lived URL to read one object (ranges included), V4 through the provider's library: absent on the S3 adapter. */
  signRead?(bucket: Bucket, key: ObjectKey, expiresInSeconds: number): Promise<{ url: string; expiresAt: string }>;
}

export interface SignedUpload {
  url: string;
  /** How the client starts the upload: this method and these headers, exactly. */
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

function bucketName(config: ObjectStorageConfig, bucket: Bucket): string {
  const name = { files: config.filesBucket, backup: config.backupBucket, siloes: config.siloesBucket, tiles: config.tilesBucket }[bucket];
  if (name === undefined) throw new AppError('configuration', `the ${bucket} bucket is not configured`, { code: `config.storage.${bucket}` });
  return name;
}

/** An S3 multipart upload's part size: above the 5 MiB minimum, and 10,000 parts reach 156 GiB. */
const S3_PART_BYTES = 16 << 20;

const notFound = (key: string): AppError => new AppError('not_found', 'object not found', { code: 'storage.not_found', details: { key } });
const failed = (operation: string, cause: unknown): AppError =>
  new AppError('unavailable', `object storage ${operation} failed`, { code: `storage.${operation}`, cause });

async function s3Store(config: ObjectStorageConfig): Promise<ObjectStore> {
  const s3 = await import('@aws-sdk/client-s3');
  const client = new s3.S3Client({
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
    ...(config.s3AccessKeyId && config.s3SecretAccessKey
      ? { credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey } } : {}),
  });
  const missing = (error: unknown): boolean => {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
  };
  return {
    async put(bucket, key, body, contentType) {
      const name = bucketName(config, bucket);
      try {
        await client.send(new s3.PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: contentType }));
      } catch (cause) {
        throw failed('put', cause);
      }
    },
    async openUpload(bucket, key, contentType) {
      const name = bucketName(config, bucket);
      // A multipart upload, started with the first full part; an object smaller than one part is put whole.
      let uploadId: string | undefined;
      const parts: { ETag: string | undefined; PartNumber: number }[] = [];
      let buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let total = 0;
      const sendPart = async (body: Buffer): Promise<void> => {
        try {
          uploadId ??= (await client.send(new s3.CreateMultipartUploadCommand({ Bucket: name, Key: key, ContentType: contentType }))).UploadId;
          const PartNumber = parts.length + 1;
          const result = await client.send(new s3.UploadPartCommand({ Bucket: name, Key: key, UploadId: uploadId, PartNumber, Body: body }));
          parts.push({ ETag: result.ETag, PartNumber });
        } catch (cause) {
          throw failed('put', cause);
        }
      };
      return {
        async write(chunk) {
          buffered.push(chunk);
          bufferedBytes += chunk.length;
          total += chunk.length;
          if (bufferedBytes < S3_PART_BYTES) return;
          const body = Buffer.concat(buffered);
          buffered = [];
          bufferedBytes = 0;
          await sendPart(body);
        },
        async finish() {
          const rest = Buffer.concat(buffered);
          buffered = [];
          if (uploadId === undefined) {
            try {
              await client.send(new s3.PutObjectCommand({ Bucket: name, Key: key, Body: rest, ContentType: contentType }));
            } catch (cause) {
              throw failed('put', cause);
            }
            return { bytes: total };
          }
          if (rest.length > 0) await sendPart(rest);
          try {
            await client.send(new s3.CompleteMultipartUploadCommand({ Bucket: name, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
          } catch (cause) {
            throw failed('put', cause);
          }
          return { bytes: total };
        },
        async abort() {
          buffered = [];
          if (uploadId !== undefined) {
            await client.send(new s3.AbortMultipartUploadCommand({ Bucket: name, Key: key, UploadId: uploadId })).catch(() => undefined);
          }
        },
      };
    },
    async get(bucket, key) {
      const name = bucketName(config, bucket);
      try {
        const result = await client.send(new s3.GetObjectCommand({ Bucket: name, Key: key }));
        return Buffer.from(await result.Body!.transformToByteArray());
      } catch (cause) {
        if (missing(cause)) throw notFound(key);
        throw failed('get', cause);
      }
    },
    async getRange(bucket, key, start, end) {
      const name = bucketName(config, bucket);
      try {
        const result = await client.send(new s3.GetObjectCommand({ Bucket: name, Key: key, Range: `bytes=${start}-${end}` }));
        return Buffer.from(await result.Body!.transformToByteArray());
      } catch (cause) {
        if (missing(cause)) throw notFound(key);
        throw failed('get', cause);
      }
    },
    async head(bucket, key) {
      const name = bucketName(config, bucket);
      try {
        const result = await client.send(new s3.HeadObjectCommand({ Bucket: name, Key: key }));
        return { bytes: result.ContentLength ?? 0, contentType: result.ContentType };
      } catch (cause) {
        if (missing(cause)) return undefined;
        throw failed('head', cause);
      }
    },
    async delete(bucket, key) {
      const name = bucketName(config, bucket);
      try {
        await client.send(new s3.DeleteObjectCommand({ Bucket: name, Key: key }));
      } catch (cause) {
        throw failed('delete', cause);
      }
    },
    async purge(bucket, key) {
      const name = bucketName(config, bucket);
      try {
        const listed = await client.send(new s3.ListObjectVersionsCommand({ Bucket: name, Prefix: key }));
        const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].filter((v) => v.Key === key);
        for (const v of versions) await client.send(new s3.DeleteObjectCommand({ Bucket: name, Key: key, VersionId: v.VersionId }));
        if (versions.length === 0) await client.send(new s3.DeleteObjectCommand({ Bucket: name, Key: key }));
        return { versions: Math.max(versions.length, 1) };
      } catch (cause) {
        throw failed('purge', cause);
      }
    },
    async list(bucket, prefix, limit) {
      const name = bucketName(config, bucket);
      try {
        const keys: ObjectKey[] = [];
        let token: string | undefined;
        do {
          const listed = await client.send(new s3.ListObjectsV2Command({
            Bucket: name, Prefix: `${prefix}/`, MaxKeys: Math.min(1_000, limit - keys.length), ContinuationToken: token,
          }));
          for (const o of listed.Contents ?? []) if (o.Key !== undefined) keys.push(o.Key as ObjectKey);
          token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (token !== undefined && keys.length < limit);
        return keys;
      } catch (cause) {
        throw failed('list', cause);
      }
    },
  };
}

async function gcsStore(config: ObjectStorageConfig): Promise<ObjectStore> {
  // Imported on use: the sovereign build carries no GCS client (spec 6.5).
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage(config.gcsEmulatorEndpoint ? { apiEndpoint: config.gcsEmulatorEndpoint } : {});
  const file = (bucket: Bucket, key: ObjectKey) => storage.bucket(bucketName(config, bucket)).file(key);
  // Resolve the file (and so the bucket) before each try: a missing bucket is a
  // configuration error, not an outage.
  const missing = (error: unknown): boolean => (error as { code?: unknown }).code === 404;
  /** Every generation of an object, deleted; how many there were. */
  const purgeVersions = async (bucket: Bucket, key: ObjectKey): Promise<number> => {
    const [files] = await storage.bucket(bucketName(config, bucket)).getFiles({ prefix: key, versions: true });
    const versions = files.filter((f) => f.name === key);
    for (const f of versions) await f.delete({ ignoreNotFound: true });
    return versions.length;
  };
  return {
    async signRead(bucket, key, expiresInSeconds) {
      const expires = Date.now() + expiresInSeconds * 1000;
      try {
        const [url] = await file(bucket, key).getSignedUrl({ version: 'v4', action: 'read', expires });
        return { url, expiresAt: new Date(expires).toISOString() };
      } catch (cause) {
        throw failed('sign', cause);
      }
    },

    async signUpload(bucket, key, options) {
      const expires = Date.now() + options.expiresInSeconds * 1000;
      const range = `0,${options.maxBytes}`;
      try {
        // v4, action resumable: the client POSTs with x-goog-resumable: start for its session, then sends the bytes in parts.
        const [url] = await file(bucket, key).getSignedUrl({
          version: 'v4', action: 'resumable', expires, contentType: options.contentType, extensionHeaders: { 'x-goog-content-length-range': range },
        });
        return { url, method: 'POST', headers: { 'x-goog-resumable': 'start', 'content-type': options.contentType, 'x-goog-content-length-range': range },
          expiresAt: new Date(expires).toISOString() };
      } catch (cause) {
        throw failed('sign', cause);
      }
    },
    async put(bucket, key, body, contentType) {
      const target = file(bucket, key);
      try {
        await target.save(body, { contentType, resumable: false });
      } catch (cause) {
        throw failed('put', cause);
      }
    },
    async openUpload(bucket, key, contentType) {
      // A resumable upload: the library sends the bytes in chunks and retries a chunk that fails.
      const stream = file(bucket, key).createWriteStream({ contentType, resumable: true });
      let failure: unknown;
      const settled = new Promise<void>((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', (error) => {
          failure ??= error;
          reject(error);
        });
      });
      settled.catch(() => undefined);
      let total = 0;
      return {
        async write(chunk) {
          if (failure !== undefined) throw failed('put', failure);
          total += chunk.length;
          if (stream.write(chunk)) return;
          await new Promise<void>((resolve, reject) => {
            stream.once('drain', resolve);
            settled.catch(reject);
          }).catch((cause: unknown) => {
            throw failed('put', cause);
          });
        },
        async finish() {
          stream.end();
          try {
            await settled;
          } catch (cause) {
            throw failed('put', cause);
          }
          return { bytes: total };
        },
        async abort() {
          // Destroying the stream leaves the library's request open, holding its sockets; ending it
          // is the one way the request is released. What that leaves at the key is then purged.
          if (failure === undefined) {
            stream.end();
            await settled.catch(() => undefined);
          }
          await purgeVersions(bucket, key).catch(() => undefined);
        },
      };
    },
    async get(bucket, key) {
      const target = file(bucket, key);
      try {
        const [contents] = await target.download();
        return contents;
      } catch (cause) {
        if (missing(cause)) throw notFound(key);
        throw failed('get', cause);
      }
    },
    async getRange(bucket, key, start, end) {
      const target = file(bucket, key);
      try {
        const [contents] = await target.download({ start, end });
        return contents;
      } catch (cause) {
        if (missing(cause)) throw notFound(key);
        throw failed('get', cause);
      }
    },
    async head(bucket, key) {
      const target = file(bucket, key);
      try {
        const [metadata] = await target.getMetadata();
        return { bytes: Number(metadata.size ?? 0), contentType: metadata.contentType };
      } catch (cause) {
        if (missing(cause)) return undefined;
        throw failed('head', cause);
      }
    },
    async delete(bucket, key) {
      const target = file(bucket, key);
      try {
        await target.delete({ ignoreNotFound: true });
      } catch (cause) {
        throw failed('delete', cause);
      }
    },
    async purge(bucket, key) {
      try {
        return { versions: await purgeVersions(bucket, key) };
      } catch (cause) {
        throw failed('purge', cause);
      }
    },
    async list(bucket, prefix, limit) {
      const name = bucketName(config, bucket);
      try {
        const [files] = await storage.bucket(name).getFiles({ prefix: `${prefix}/`, maxResults: limit, autoPaginate: true });
        return files.map((f) => f.name as ObjectKey);
      } catch (cause) {
        throw failed('list', cause);
      }
    },
  };
}

export async function createObjectStore(config: ObjectStorageConfig): Promise<ObjectStore> {
  return config.provider === 's3' ? s3Store(config) : gcsStore(config);
}
