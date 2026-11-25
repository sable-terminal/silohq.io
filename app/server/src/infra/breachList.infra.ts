// The breach list a new password is checked against when it is set, never at login
// (spec 55.3). It is the downloadable Pwned Passwords dataset held inside the cell, read
// from disk; no password, and no part of its hash, leaves the cell (invariant 11).
//
// Layout, as the dataset's own downloader writes it: one file per first five hex
// characters of the password's SHA-1, named <PREFIX> or <PREFIX>.txt, each line
// SUFFIX:COUNT with the remaining 35 characters in upper case. SHA-1 is the dataset's
// format, not a choice: passwords themselves are hashed with Argon2id.
//
// Without a directory (development and tests only; production auth refuses to start,
// index.config) nothing is reported breached.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors.util.ts';

export interface BreachList {
  /** Whether the password appears in the dataset. */
  contains(password: string): Promise<boolean>;
  readonly configured: boolean;
}

export function createBreachList(directory: string | undefined): BreachList {
  if (directory === undefined) {
    return { configured: false, contains: async () => false };
  }
  const read = async (prefix: string): Promise<string | undefined> => {
    for (const name of [`${prefix}.txt`, prefix]) {
      try {
        return await readFile(path.join(directory, name), 'utf8');
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') {
          throw new AppError('unavailable', 'the breach list could not be read', { code: 'breach_list.unreadable', cause: error });
        }
      }
    }
    return undefined;
  };
  return {
    configured: true,
    async contains(password) {
      const hash = createHash('sha1').update(password.normalize('NFC'), 'utf8').digest('hex').toUpperCase();
      const range = await read(hash.slice(0, 5));
      if (range === undefined) {
        // Every prefix exists in the full dataset, so a missing file means a broken copy.
        throw new AppError('unavailable', 'the breach list is incomplete', { code: 'breach_list.incomplete' });
      }
      const suffix = hash.slice(5);
      return range.split(/\r?\n/).some((line) => line.startsWith(suffix) && line[35] === ':');
    },
  };
}
