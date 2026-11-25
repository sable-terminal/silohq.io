// The advisory feed (spec 11.1): where fleet-control reads OSV's exports from. The layout is
// osv.dev's public one, per ecosystem:
//
//   <base>/<ecosystem>/all.zip             every record, one JSON file each
//   <base>/<ecosystem>/modified_id.csv     "<modified>,<id>" per record, newest first
//   <base>/<ecosystem>/<id>.json           one record
//
// The base is https: (osv.dev's bucket, or a mirror of it) or file: (a copy brought in on
// approved media, for a tier that reaches no outside service). Large files are read by
// range and the list as a stream, so neither is held whole.

import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppError } from '../utils/errors.util.ts';

export interface AdvisorySource {
  /** The base, for logs and errors. */
  readonly base: string;
  /** A file's size, or undefined when there is none. */
  size(path: string): Promise<number | undefined>;
  /** Bytes start (inclusive) to end (exclusive). */
  read(path: string, start: number, end: number): Promise<Buffer>;
  /** A text file line by line, front to back; stopping early stops the read. */
  lines(path: string): AsyncGenerator<string>;
  /** A small file whole, or undefined when there is none. */
  text(path: string): Promise<string | undefined>;
}

const PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._:-]+)*$/;
const checked = (path: string): string => {
  if (!PATH.test(path) || path.split('/').some((p) => p === '..' || p === '.')) throw new TypeError(`not a feed path: ${path}`);
  return path;
};

const failed = (operation: string, base: string, cause: unknown): AppError =>
  new AppError('unavailable', `the advisory feed could not ${operation}`, { code: `fleet.advisory_feed_${operation}`, cause, details: { base } });

async function* splitLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  for await (const chunk of chunks) {
    carry += decoder.decode(chunk, { stream: true });
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      yield carry.slice(0, newline).replace(/\r$/, '');
      carry = carry.slice(newline + 1);
      newline = carry.indexOf('\n');
    }
  }
  carry += decoder.decode();
  if (carry !== '') yield carry.replace(/\r$/, '');
}

function httpFeed(base: string, timeoutMs: number): AdvisorySource {
  const url = (path: string): string => `${base.replace(/\/+$/, '')}/${checked(path).split('/').map(encodeURIComponent).join('/')}`;
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    try {
      return await fetch(url(path), { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      throw failed('fetch', base, cause);
    }
  };
  return {
    base,
    async size(path) {
      const response = await request(path, { method: 'HEAD' });
      if (response.status === 404) return undefined;
      if (!response.ok) throw failed('fetch', base, new Error(`HEAD ${path}: ${response.status}`));
      const length = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(length) || length < 0) throw failed('fetch', base, new Error(`HEAD ${path}: no content length`));
      return length;
    },
    async read(path, start, end) {
      if (end <= start) return Buffer.alloc(0);
      const response = await request(path, { headers: { range: `bytes=${start}-${end - 1}` } });
      if (response.status !== 206 && !(response.status === 200 && start === 0)) {
        throw failed('fetch', base, new Error(`GET ${path} bytes ${start}-${end - 1}: ${response.status}`));
      }
      const body = Buffer.from(await response.arrayBuffer());
      return response.status === 200 ? body.subarray(0, end - start) : body;
    },
    async *lines(path) {
      const controller = new AbortController();
      const response = await request(path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs * 10)]) });
      if (!response.ok || response.body === null) throw failed('fetch', base, new Error(`GET ${path}: ${response.status}`));
      try {
        yield* splitLines(response.body);
      } finally {
        controller.abort();
      }
    },
    async text(path) {
      const response = await request(path);
      if (response.status === 404) return undefined;
      if (!response.ok) throw failed('fetch', base, new Error(`GET ${path}: ${response.status}`));
      return response.text();
    },
  };
}

function fileFeed(base: string): AdvisorySource {
  const root = fileURLToPath(base.endsWith('/') ? base : `${base}/`);
  const file = (path: string): string => `${root}${checked(path)}`;
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
  return {
    base,
    async size(path) {
      try {
        return (await stat(file(path))).size;
      } catch (error) {
        if (missing(error)) return undefined;
        throw failed('read', base, error);
      }
    },
    async read(path, start, end) {
      const handle = await open(file(path), 'r').catch((error: unknown) => { throw failed('read', base, error); });
      try {
        const out = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(out, 0, end - start, start);
        return out.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async *lines(path) {
      const stream = createReadStream(file(path));
      try {
        yield* splitLines(stream);
      } catch (error) {
        throw failed('read', base, error);
      } finally {
        stream.destroy();
      }
    },
    async text(path) {
      try {
        return await readFile(file(path), 'utf8');
      } catch (error) {
        if (missing(error)) return undefined;
        throw failed('read', base, error);
      }
    },
  };
}

export function createAdvisorySource(base: string, options: { timeoutMs?: number } = {}): AdvisorySource {
  if (base.startsWith('file:')) return fileFeed(base);
  if (base.startsWith('https:') || base.startsWith('http:')) return httpFeed(base, options.timeoutMs ?? 120_000);
  throw new AppError('configuration', 'FLEET_ADVISORY_URL is https: or file:', { code: 'config.fleet_advisory_url' });
}
