// The web client, served by the gateway at its public origin beside the API (spec 7.3, 33):
// the static export of app/web, loaded once when the gateway starts (GATEWAY_WEB_ROOT).
//
// - Only what the export holds is served: every request is looked up in the index built at
//   load, never resolved against the file system, so no path reaches anything else.
// - Each page's Content-Security-Policy allows exactly its own inline scripts, by hash, and
//   scripts and styles from this origin; nothing else loads, frames it or is framed.
// - Content-hashed assets (/_next/static) are cached for a year; pages and the client's data
//   files revalidate, by ETag. Text is precompressed with Brotli for clients that take it.
// - A path with no page is the export's 404 page; a page's path without its trailing slash
//   is redirected to it. API paths never reach this: the API answers them first.
// - A page carries no data: everything a page shows comes through the API, under the session.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants as zlib } from 'node:zlib';

export interface WebFile {
  readonly body: Buffer;
  readonly brotli: Buffer | undefined;
  readonly contentType: string;
  readonly etag: string;
  /** Content-hashed: cached for a year. */
  readonly immutable: boolean;
  /** A page's own policy: its inline scripts and styles by hash. */
  readonly csp: string | undefined;
}

export interface WebClient {
  readonly files: ReadonlyMap<string, WebFile>;
  readonly notFound: WebFile | undefined;
  readonly bytes: number;
}

/** Bounds on what a web root may hold: a mistaken root (a home directory) fails at start. */
export const WEB_LIMITS = { files: 20_000, bytes: 256 * 1024 * 1024 } as const;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.txt', '.json', '.map', '.webmanifest', '.svg']);

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('base64');

/** The hash sources of a page's inline scripts and styles, in the order they appear. */
export function inlineHashes(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(m[1]!) && m[2]!.length > 0) scripts.push(`'sha256-${sha256(m[2]!)}'`);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(`'sha256-${sha256(m[1]!)}'`);
  return { scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

/**
 * A page's policy: this origin, its own inline scripts and styles, nothing framed, nothing framing
 * it. connectOrigins: the object store's origins, so a large upload goes straight to its signed URL.
 * WebAssembly may be compiled (never JavaScript evaluated): the 3D asset view decodes compressed
 * models and textures with three.js's own decoders, served from this origin (D228).
 */
export function pagePolicy(hashes: { scripts: string[]; styles: string[] }, connectOrigins: readonly string[] = []): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.scripts.join(' ')} 'wasm-unsafe-eval'`.replace('  ', ' '),
    `style-src 'self' ${hashes.styles.join(' ')}`.trim(),
    // A media set's items (D237): from a blob of the reply, or straight from storage's signed link.
    `img-src 'self' data: blob: ${connectOrigins.join(' ')}`.trim(),
    `media-src 'self' blob: ${connectOrigins.join(' ')}`.trim(),
    "font-src 'self'",
    `connect-src 'self' ${connectOrigins.join(' ')}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * A script's own policy. A page's script ignores it, but a dedicated worker takes the policy of
 * the script it runs from (the canvas lays out in one, 29.8): it may load its chunks from this
 * origin and reach what the page may, and nothing else.
 */
export function workerPolicy(connectOrigins: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src 'self' ${connectOrigins.join(' ')}`.trim(),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(full);
    if (out.length > WEB_LIMITS.files) throw new Error(`the web root holds more than ${WEB_LIMITS.files} files: is ${root} the client's export?`);
  }
}

/** Loads the export at root: every file it serves, indexed by URL path. */
export async function loadWebClient(root: string, options: { connectOrigins?: readonly string[] } = {}): Promise<WebClient> {
  const absolute = path.resolve(root);
  if (!(await stat(absolute).catch(() => undefined))?.isDirectory()) throw new Error(`the web root ${absolute} is not a directory`);
  const found: string[] = [];
  await walk(absolute, absolute, found);
  const files = new Map<string, WebFile>();
  let bytes = 0;
  for (const full of found.sort()) {
    const extension = path.extname(full).toLowerCase();
    const contentType = TYPES[extension];
    if (contentType === undefined) continue;
    const body = await readFile(full);
    bytes += body.length;
    if (bytes > WEB_LIMITS.bytes) throw new Error(`the web root holds more than ${WEB_LIMITS.bytes} bytes: is ${absolute} the client's export?`);
    const urlPath = `/${path.relative(absolute, full).split(path.sep).map(encodeURIComponent).join('/')}`;
    const html = extension === '.html';
    files.set(urlPath, {
      body,
      brotli: COMPRESSIBLE.has(extension) && body.length > 1024
        ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } }) : undefined,
      contentType,
      etag: `"${sha256(body).slice(0, 27)}"`,
      immutable: urlPath.startsWith('/_next/static/'),
      csp: html ? pagePolicy(inlineHashes(body.toString('utf8')), options.connectOrigins ?? [])
        : extension === '.js' || extension === '.mjs' ? workerPolicy(options.connectOrigins ?? []) : undefined,
    });
  }
  if (!files.has('/index.html')) throw new Error(`the web root ${absolute} has no index.html: is it the client's export (npm run build in app/web)?`);
  return { files, notFound: files.get('/404.html'), bytes };
}

export type WebAnswer =
  | { kind: 'file'; file: WebFile; status: 200 | 404 }
  | { kind: 'redirect'; location: string };

/**
 * What a GET or HEAD of pathname answers: a file of the export, a page's index, a redirect to
 * a page's path with its trailing slash, or the 404 page. Undefined when the export has no 404 page.
 */
export function answerFor(client: WebClient, pathname: string, search: string): WebAnswer | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return client.notFound === undefined ? undefined : { kind: 'file', file: client.notFound, status: 404 };
  }
  const key = (p: string): string => `/${p.split('/').filter((s) => s !== '').map(encodeURIComponent).join('/')}`;
  if (decoded.endsWith('/')) {
    const page = client.files.get(key(`${decoded}index.html`));
    if (page !== undefined) return { kind: 'file', file: page, status: 200 };
  } else {
    const file = client.files.get(key(decoded));
    if (file !== undefined) return { kind: 'file', file, status: 200 };
    // From the normalised path, never the raw one: //host would leave the origin.
    if (client.files.has(key(`${decoded}/index.html`))) return { kind: 'redirect', location: `${key(decoded)}/${search}` };
  }
  return client.notFound === undefined ? undefined : { kind: 'file', file: client.notFound, status: 404 };
}
