// An object store in memory for service tests: what was put, under which key, in which bucket.

import type { Bucket, ObjectKey, ObjectStore } from '../../src/infra/objectStorage.infra.ts';

export interface MemoryStore extends ObjectStore {
  objects: Map<string, { body: Buffer; contentType: string }>;
  keys(bucket: Bucket): string[];
}

export function createMemoryStore(): MemoryStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const at = (bucket: Bucket, key: string) => `${bucket}:${key}`;
  return {
    objects,
    keys: (bucket) => [...objects.keys()].filter((k) => k.startsWith(`${bucket}:`)).map((k) => k.slice(bucket.length + 1)),
    async put(bucket, key, body, contentType) { objects.set(at(bucket, key), { body, contentType }); },
    // A streamed upload in memory: visible at the key once finished.
    async openUpload(bucket, key, contentType) {
      const chunks: Buffer[] = [];
      return {
        async write(chunk) { chunks.push(Buffer.from(chunk)); },
        async finish() { const body = Buffer.concat(chunks); objects.set(at(bucket, key), { body, contentType }); return { bytes: body.length }; },
        async abort() { chunks.length = 0; },
      };
    },
    async get(bucket, key) {
      const found = objects.get(at(bucket, key));
      if (found === undefined) throw Object.assign(new Error('not found'), { code: 'storage.not_found' });
      return found.body;
    },
    async getRange(bucket, key, start, end) {
      const found = objects.get(at(bucket, key));
      if (found === undefined) throw Object.assign(new Error('not found'), { code: 'storage.not_found' });
      return found.body.subarray(start, end + 1);
    },
    async head(bucket, key) { const f = objects.get(at(bucket, key)); return f && { bytes: f.body.length, contentType: f.contentType }; },
    async delete(bucket, key) { objects.delete(at(bucket, key)); },
    // A signed upload in memory: the URL names the bucket and key; a test "uploads" with put.
    async signUpload(bucket, key, options) {
      return { url: `memory://${bucket}/${key}`, method: 'POST' as const, headers: { 'x-goog-content-length-range': `0,${options.maxBytes}` },
        expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000).toISOString() };
    },
    // A signed read in memory: the URL names the bucket and key; a test reads it with get.
    async signRead(bucket, key, expiresInSeconds) {
      return { url: `memory://${bucket}/${key}`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
    },
    async purge(bucket, key) { return { versions: objects.delete(at(bucket, key)) ? 1 : 0 }; },
    async list(bucket, prefix: ObjectKey, limit) {
      return [...objects.keys()].filter((k) => k.startsWith(`${bucket}:${prefix}/`)).slice(0, limit).map((k) => k.slice(bucket.length + 1) as ObjectKey);
    },
  };
}
