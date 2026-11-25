// fleet-control's artefact store (spec 7.2: "Owns: Release registry, artefact store"):
// the published copies of signed release manifests, signed channel heads and signed
// bundle manifests, and the Silo Agent binaries releases name, by the SHA-256 of their bytes.
// The record of each, and all of fleet-control's state, is in the fleet tables; a copy
// written again carries the same signed document.
//
// This build keeps them in a directory (FLEET_ARTEFACT_DIR). An air-gapped or
// self-managed fleet-control uses it as it is; the hosted one needs an artefact bucket
// in the object storage adapter (README: global tier). Writes are whole-file and renamed
// into place, so a reader never sees half a document.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../utils/errors.util.ts';

export interface ArtefactStore {
  /** Writes an immutable document. 'exists' if one is already there (compare it yourself). */
  create(key: string, body: Buffer): Promise<'created' | 'exists'>;
  /** Writes a state document, replacing the one there. */
  write(key: string, body: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | undefined>;
  /** Up to length bytes from start, and the whole document's size; undefined if there is none. */
  readRange(key: string, start: number, length: number): Promise<{ bytes: number; data: Buffer } | undefined>;
  /** The SHA-256 of the whole document, hex, and its size; undefined if there is none. */
  sha256(key: string): Promise<{ hex: string; bytes: number } | undefined>;
  /** The names directly under a prefix, sorted. */
  list(prefix: string): Promise<string[]>;
}

const PART = /^[A-Za-z0-9_.+-]{1,200}$/;

function checkKey(key: string): string[] {
  const parts = key.split('/');
  if (parts.length === 0 || parts.some((p) => !PART.test(p) || p === '.' || p === '..')) {
    throw new TypeError('an artefact key is a path of plain names');
  }
  return parts;
}

const failed = (operation: string, cause: unknown): AppError =>
  new AppError('unavailable', `the artefact store could not ${operation}`, { code: `fleet.store_${operation}`, cause });

export function directoryArtefactStore(root: string): ArtefactStore {
  const resolve = (key: string): string => path.join(root, ...checkKey(key));
  const staged = async (file: string, body: Buffer): Promise<string> => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, body, { mode: 0o640 });
    return temporary;
  };
  return {
    async create(key, body) {
      const file = resolve(key);
      let temporary: string | undefined;
      try {
        temporary = await staged(file, body);
        // link fails if the target exists, so two writers cannot both create it.
        await link(temporary, file);
        return 'created';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw failed('write', error);
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
    async write(key, body) {
      const file = resolve(key);
      let temporary: string | undefined;
      try {
        temporary = await staged(file, body);
        await rename(temporary, file);
      } catch (error) {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
        throw failed('write', error);
      }
    },
    async read(key) {
      try {
        return await readFile(resolve(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw failed('read', error);
      }
    },
    async readRange(key, start, length) {
      let handle;
      try {
        handle = await open(resolve(key), 'r');
        const { size } = await handle.stat();
        const take = Math.max(0, Math.min(length, size - start));
        const data = Buffer.alloc(take);
        let read = 0;
        while (read < take) {
          const { bytesRead } = await handle.read(data, read, take - read, start + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return { bytes: size, data: data.subarray(0, read) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw failed('read', error);
      } finally {
        await handle?.close();
      }
    },
    async sha256(key) {
      const file = resolve(key);
      try {
        const { size } = await stat(file);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
        return { hex: hash.digest('hex'), bytes: size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw failed('read', error);
      }
    },
    async list(prefix) {
      try {
        return (await readdir(resolve(prefix))).filter((name) => !name.endsWith('.tmp')).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw failed('list', error);
      }
    },
  };
}
