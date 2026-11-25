// The web client at the gateway's public origin (spec 7.3, 33): the static export served
// beside the API from what was loaded at start. Each page's policy allows its own inline
// scripts by hash and nothing inline besides; hashed assets are cached for a year and pages
// revalidate; a page's path without its trailing slash redirects within the origin; a path
// with no page is the export's 404 page, and no path reaches a file outside the export. A
// page opens from a link on another site, while the API still refuses cross-site requests.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { brotliDecompressSync } from 'node:zlib';
import { loadConfig } from '../../src/config/index.config.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { inlineHashes, loadWebClient } from '../../src/services/gateway/webClient.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const ORIGIN = 'https://app.silo.test';
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });
const INLINE = '(self.__next_f=self.__next_f||[]).push([0])';
const page = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title>`
  + '<script src="/_next/static/chunks/main-abc123.js" async=""></script></head>'
  + `<body><main>${title}</main><script>${INLINE}</script><script>self.__next_f.push([1,"${title}"])</script></body></html>`;
const BUNDLE = `console.log(${JSON.stringify('x'.repeat(4096))});`;

let root: string;
let gateway: RunningProcess;
let url: string;

async function startGateway(webRoot: string): Promise<{ process: RunningProcess; url: string }> {
  let port = 0;
  const process = await runProcess([createGatewayService({ onListening: (p) => { port = p; } })], loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'gateway', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
    SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1', GATEWAY_WEB_ROOT: webRoot,
    GATEWAY_UPLOAD_ORIGINS: 'https://storage.googleapis.com',
  }), { logger: quiet });
  return { process, url: `http://127.0.0.1:${port}` };
}

const get = (pathname: string, headers: Record<string, string> = {}) => fetch(`${url}${pathname}`, { headers, redirect: 'manual' });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'silo-web-'));
  await mkdir(path.join(root, 'sign-in'), { recursive: true });
  await mkdir(path.join(root, '_next/static/chunks'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), page('Home'));
  await writeFile(path.join(root, 'index.txt'), '0:["home"]');
  await writeFile(path.join(root, 'sign-in/index.html'), page('Sign in'));
  await writeFile(path.join(root, '404.html'), page('Not found'));
  await writeFile(path.join(root, '_next/static/chunks/main-abc123.js'), BUNDLE);
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  ({ process: gateway, url } = await startGateway(root));
});

after(async () => {
  await gateway?.stop('test');
  if (root) await rm(root, { recursive: true, force: true });
});

describe('the web client at the public origin', () => {
  test('a page, with a policy that allows exactly its own inline scripts', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await res.text(), /<main>Home<\/main>/);
    const csp = res.headers.get('content-security-policy')!;
    const hash = `'sha256-${createHash('sha256').update(INLINE).digest('base64')}'`;
    assert.ok(csp.includes(`script-src 'self' ${hash}`), csp);
    // No inline script but its own, and no JavaScript evaluated; WebAssembly may be compiled, for the 3D view's decoders (D228).
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes("'unsafe-eval'"), csp);
    assert.match(csp, /script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+ 'wasm-unsafe-eval';/);
    assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), csp);
    // A large upload goes straight to the object store's signed URL: its origin, and only it, besides this one.
    assert.ok(csp.includes("connect-src 'self' https://storage.googleapis.com;"), csp);
    // A media set's items play straight from storage's signed links, or from a blob of the reply (D237).
    assert.ok(csp.includes("media-src 'self' blob: https://storage.googleapis.com;") && csp.includes("img-src 'self' data: blob: https://storage.googleapis.com;"), csp);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-cache', 'a page revalidates: a new release is seen at once');
    const again = await get('/', { 'if-none-match': res.headers.get('etag')! });
    assert.equal(again.status, 304);
  });

  test('an upload origin must be an origin', () => {
    assert.throws(() => loadConfig({
      SILO_ENV: 'test', SILO_SERVICE: 'gateway', SILO_CELL_ID: CELL_ID, GATEWAY_UPLOAD_ORIGINS: 'https://storage.googleapis.com/bucket',
    }), /GATEWAY_UPLOAD_ORIGINS/);
  });

  test('hashed assets are cached for a year, and sent compressed to a client that takes it', async () => {
    const plain = await get('/_next/static/chunks/main-abc123.js');
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(plain.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await plain.text(), BUNDLE);
    // A script run as a worker takes this policy: its chunks from this origin, and nothing else.
    assert.equal(plain.headers.get('content-security-policy'),
      "default-src 'none'; script-src 'self'; connect-src 'self' https://storage.googleapis.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    // node:http, which leaves the body as sent (fetch decompresses it).
    const { headers, body } = await new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      httpGet(`${url}/_next/static/chunks/main-abc123.js`, { headers: { 'accept-encoding': 'gzip, br' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(headers['content-encoding'], 'br');
    assert.ok(body.length < BUNDLE.length / 4);
    assert.equal(brotliDecompressSync(body).toString(), BUNDLE);
  });

  test('a page\'s path without its slash redirects to it within the origin; no path leaves the origin', async () => {
    const res = await get('/sign-in?next=%2Fexplorer%2F');
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), '/sign-in/?next=%2Fexplorer%2F');
    const doubled = await get('//sign-in');
    assert.equal(doubled.headers.get('location'), '/sign-in/', 'never //sign-in/, which a browser reads as another host');
    assert.match(await (await get('/sign-in/')).text(), /<main>Sign in<\/main>/);
  });

  test('a path with no page is the 404 page; nothing outside the export is reachable', async () => {
    const res = await get('/nowhere/');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /<main>Not found<\/main>/);
    for (const probe of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/.env', '/sign-in/../../.env', '/%E0%A4%A']) {
      const answer = await get(probe);
      assert.equal(answer.status, 404, probe);
      assert.ok(!(await answer.text()).includes('SECRET'), probe);
    }
  });

  test('a page opens from a link on another site; the API still refuses a cross-site request', async () => {
    assert.equal((await get('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status, 200);
    const api = await get('/api/v1/session', { 'sec-fetch-site': 'cross-site' });
    assert.equal(api.status, 403);
    assert.equal((await api.json() as { error: { code: string } }).error.code, 'gateway.cross_site');
  });

  test('API paths are the API\'s: an unknown one is a JSON 404, never a page', async () => {
    const res = await get('/api/v1/no-such-route');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type')!, /application\/json/);
    const post = await fetch(`${url}/`, { method: 'POST', headers: { origin: ORIGIN, 'x-silo-csrf': '1' } });
    assert.notEqual(post.status, 200, 'a page is only ever read');
  });

  test('the export is checked at start: a root without the client fails, naming why', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'silo-web-empty-'));
    try {
      await assert.rejects(loadWebClient(empty), /no index\.html/);
      await assert.rejects(loadWebClient(path.join(empty, 'missing')), /not a directory/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('inline scripts with a src, and empty ones, need no hash', () => {
    assert.deepEqual(inlineHashes('<script src="/a.js"></script><script></script><script>x()</script><style>a{}</style>'), {
      scripts: [`'sha256-${createHash('sha256').update('x()').digest('base64')}'`],
      styles: [`'sha256-${createHash('sha256').update('a{}').digest('base64')}'`],
    });
  });
});
