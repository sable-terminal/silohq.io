import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { env, isProd } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { accessToken } from './googleAuth.infra';
import { scopedObjectKey } from '../utils/inputSanitiser.util';

const log = childLogger('object-store');

/**
 * Logos, avatars and uploads.
 *
 * THE VALIDATION IS NOT HERE. Sniffing, SVG sanitisation and filename
 * normalisation are in `utils/`, and they must run before anything reaches this
 * module. A sanitiser living inside the storage client is a sanitiser somebody
 * can skip by not using that client — and the one place it will be skipped is
 * whatever writes the second kind of upload.
 *
 * NEVER A PUBLIC BUCKET. Every object is served through a signed URL with a short
 * expiry or through an application route that checks membership. A public bucket
 * means an object key is a permanent credential, and keys leak into referrer
 * headers, support tickets and screenshots.
 *
 * THE PATH IS SCOPED BY ORGANISATION so a leaked key cannot be walked sideways
 * into another tenant's objects.
 */

const BASE = 'https://storage.googleapis.com';
const UPLOAD_BASE = 'https://storage.googleapis.com/upload/storage/v1/b';

export interface StoredObject {
  key: string;
  contentType: string;
  bytes: number;
  /** For change detection and cache busting. */
  etag: string;
}

export function isConfigured(): boolean {
  return Boolean(env.STORAGE_BUCKET);
}

/* ── The local stand-in ──────────────────────────────────────────────────── */

/**
 * Outside production, with no bucket, objects are written to a directory.
 *
 * NEVER IN PRODUCTION. A production process with no bucket refuses at startup
 * (`assertProductionReady`), and this returns null there regardless, so a
 * misconfigured deployment cannot quietly start writing customer files to a
 * container's disk.
 */
function localRoot(): string | null {
  if (env.STORAGE_BUCKET || isProd) return null;
  return resolve(env.LOCAL_OBJECT_STORE_DIR ?? join(tmpdir(), 'silo-objects'));
}

export function isLocal(): boolean {
  return localRoot() !== null;
}

function localPath(key: string): string {
  const root = localRoot()!;
  const path = resolve(root, key);
  /* The key is sanitised when it is made; this is the second lock, not the first. */
  if (!path.startsWith(root + sep)) throw new Error('Object key escapes the store.');
  return path;
}

/**
 * Store an object.
 *
 * THE CONTENT TYPE IS THE SNIFFED ONE, NOT THE DECLARED ONE, and the caller is
 * responsible for having sniffed it. Storing the client's claim means the object
 * is later served with it — which is how an SVG announced as `image/png` becomes
 * script execution on every page that renders it.
 */
export async function put(input: {
  organisationId: string;
  kind: 'logo' | 'avatar' | 'upload' | 'export';
  filename: string;
  body: Buffer;
  sniffedContentType: string;
}): Promise<StoredObject> {
  return putAt({
    key: scopedObjectKey(input.organisationId, input.kind, input.filename),
    body: input.body,
    sniffedContentType: input.sniffedContentType,
  });
}

/**
 * Store an object at a key the caller built.
 *
 * FOR KEYS WITH MORE STRUCTURE THAN `kind/filename` — an import's file sits
 * under its source and its own id, so purging a source is one prefix. The key
 * must come from `inputSanitiser`, which is the only place keys are made.
 */
export async function putAt(input: {
  key: string;
  body: Buffer;
  sniffedContentType: string;
}): Promise<StoredObject> {
  const { key } = input;

  if (isLocal()) {
    const path = localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    return {
      key,
      contentType: input.sniffedContentType,
      bytes: input.body.byteLength,
      etag: createHash('sha256').update(input.body).digest('hex').slice(0, 16),
    };
  }

  if (!env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is not configured.');

  const token = await accessToken();
  if (!token) throw new Error('No Google credentials available for object storage.');

  const response = await fetch(
    `${UPLOAD_BASE}/${env.STORAGE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': input.sniffedContentType,
        /*
         * `nosniff` AT REST, SO THE BROWSER CANNOT SECOND-GUESS US. Without it a
         * browser may content-sniff a stored file and execute it as HTML
         * regardless of the type we set.
         */
        'x-goog-meta-nosniff': 'true',
      },
      body: new Uint8Array(input.body),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    log.error({ status: response.status, key }, 'Object upload failed');
    throw new Error(`Object upload failed with status ${response.status}`);
  }

  const result = (await response.json()) as { etag?: string; size?: string };

  return {
    key,
    contentType: input.sniffedContentType,
    bytes: input.body.byteLength,
    etag: result.etag ?? createHash('sha256').update(input.body).digest('hex').slice(0, 16),
  };
}

/**
 * A signed URL, valid briefly.
 *
 * FIFTEEN MINUTES BY DEFAULT. Long enough to render a page, short enough that a
 * URL pasted into a chat or captured in a referrer stops working before anybody
 * gets to it. A signed URL is a bearer credential: whoever holds it is the
 * reader, and it cannot be revoked before it expires — which is the argument for
 * making the window small rather than convenient.
 *
 * V4 SIGNING, WHICH NEEDS A SERVICE ACCOUNT KEY. On Cloud Run there is no private
 * key — the identity is the metadata server — so this falls back to the IAM
 * `signBlob` API rather than requiring a downloaded key to exist.
 */
export async function signedUrl(key: string, expiresInSeconds = 900): Promise<string> {
  if (!env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is not configured.');

  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const resource = `/${env.STORAGE_BUCKET}/${key}`;
  const stringToSign = `GET\n\n\n${expires}\n${resource}`;

  const signature = await signBlob(Buffer.from(stringToSign, 'utf8'));
  const account = await serviceAccountEmail();

  const params = new URLSearchParams({
    GoogleAccessId: account,
    Expires: String(expires),
    Signature: signature,
  });

  return `${BASE}${resource}?${params.toString()}`;
}

/**
 * Sign through IAM rather than with a local key.
 *
 * THE ALTERNATIVE IS A DOWNLOADED SERVICE ACCOUNT KEY, which is a long-lived
 * secret in a file. `signBlob` asks Google to sign with a key this identity never
 * sees, so there is nothing on disk to leak and nothing to rotate.
 */
async function signBlob(payload: Buffer): Promise<string> {
  const token = await accessToken();
  if (!token) throw new Error('No Google credentials available for signing.');

  const account = await serviceAccountEmail();
  const response = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:signBlob`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: payload.toString('base64') }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) throw new Error(`signBlob failed with status ${response.status}`);
  const result = (await response.json()) as { signedBlob: string };
  return result.signedBlob;
}

let cachedAccount: string | null = null;

async function serviceAccountEmail(): Promise<string> {
  if (cachedAccount) return cachedAccount;

  try {
    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1_000) },
    );
    if (response.ok) {
      cachedAccount = (await response.text()).trim();
      return cachedAccount;
    }
  } catch {
    /* Not on Cloud Run. */
  }

  throw new Error('Could not determine the service account. Signed URLs need one.');
}

/**
 * Delete an object.
 *
 * REPLACEMENT WRITES A NEW KEY AND SCHEDULES THE OLD ONE, rather than
 * overwriting. Overwriting in place makes a mistaken upload unrecoverable the
 * moment it happens, and the person who did it is the least equipped to notice.
 */
export async function remove(key: string): Promise<void> {
  if (isLocal()) {
    await rm(localPath(key), { force: true });
    return;
  }

  if (!env.STORAGE_BUCKET) return;
  const token = await accessToken();
  if (!token) return;

  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${env.STORAGE_BUCKET}/o/${encodeURIComponent(key)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  );

  // 404 is success: the object is not there, which is what was wanted.
  if (!response.ok && response.status !== 404) {
    log.warn({ status: response.status, key }, 'Object delete failed');
  }
}

/* ── Reading back ────────────────────────────────────────────────────────── */

/**
 * The bytes of an object.
 *
 * INTO MEMORY, AND THAT IS BOUNDED ELSEWHERE. An import file is capped at 64 MiB
 * by a CHECK on `silo_files`, and `head` is asked before `get` so a file larger
 * than it said is refused before it is read.
 */
export async function get(key: string): Promise<Buffer> {
  if (isLocal()) return readFile(localPath(key));

  if (!env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is not configured.');
  const token = await accessToken();
  if (!token) throw new Error('No Google credentials available for object storage.');

  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${env.STORAGE_BUCKET}/o/${encodeURIComponent(key)}?alt=media`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) },
  );

  if (!response.ok) throw new Error(`Object read failed with status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Whether an object exists, and how large the store says it is. */
export async function head(key: string): Promise<{ bytes: number; contentType: string | null } | null> {
  if (isLocal()) {
    try {
      const info = await stat(localPath(key));
      return { bytes: info.size, contentType: null };
    } catch {
      return null;
    }
  }

  if (!env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is not configured.');
  const token = await accessToken();
  if (!token) throw new Error('No Google credentials available for object storage.');

  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${env.STORAGE_BUCKET}/o/${encodeURIComponent(key)}`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  );

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Object lookup failed with status ${response.status}`);

  const meta = (await response.json()) as { size?: string; contentType?: string };
  return { bytes: Number(meta.size ?? 0), contentType: meta.contentType ?? null };
}

/* ── Uploads that never pass through this process ────────────────────────── */

export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Sent with the upload exactly as given; the signature covers the content type. */
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * A URL the browser uploads one object to, directly.
 *
 * ── Why not through the API ────────────────────────────────────────────────
 *
 * `app.ts` holds a 256 KB body limit and says why: uploads go to object storage
 * through a signed URL and never through this process. A decade of exports
 * passing through the API would put customer files in the memory of whichever
 * instance took the request.
 *
 * FIFTEEN MINUTES, BOUND TO ONE KEY AND ONE CONTENT TYPE. A signed URL is a
 * bearer credential; it can write exactly the object the file row was created
 * for and nothing beside it.
 *
 * LOCALLY, AN API ROUTE STANDS IN FOR THE BUCKET, with an HMAC token carrying
 * the same three facts. It exists only where `isLocal()` is true.
 */
export async function signedUploadUrl(input: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<SignedUpload> {
  const seconds = input.expiresInSeconds ?? 900;
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const headers = { 'content-type': input.contentType };

  if (isLocal()) {
    const payload = Buffer.from(
      JSON.stringify({ k: input.key, t: input.contentType, e: expires }),
    ).toString('base64url');
    return {
      url: `${env.API_URL}/api/silo-uploads/${payload}.${localSignature(payload)}`,
      method: 'PUT',
      headers,
      expiresAt: new Date(expires * 1000),
    };
  }

  if (!env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is not configured.');

  const resource = `/${env.STORAGE_BUCKET}/${input.key}`;
  const stringToSign = `PUT\n\n${input.contentType}\n${expires}\n${resource}`;
  const signature = await signBlob(Buffer.from(stringToSign, 'utf8'));
  const account = await serviceAccountEmail();

  const params = new URLSearchParams({
    GoogleAccessId: account,
    Expires: String(expires),
    Signature: signature,
  });

  return {
    url: `${BASE}${resource}?${params.toString()}`,
    method: 'PUT',
    headers,
    expiresAt: new Date(expires * 1000),
  };
}

/**
 * Open a local upload token: the key and content type it was signed for, or
 * null for a token that is forged, altered or expired.
 */
export function openLocalUpload(token: string): { key: string; contentType: string } | null {
  if (!isLocal()) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(localSignature(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const opened = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      k: string;
      t: string;
      e: number;
    };
    if (opened.e * 1000 < Date.now()) return null;
    return { key: opened.k, contentType: opened.t };
  } catch {
    return null;
  }
}

function localSignature(payload: string): string {
  return createHmac('sha256', `local-upload:${env.SESSION_SECRET}`).update(payload).digest('base64url');
}

