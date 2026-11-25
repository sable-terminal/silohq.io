// Password hashing with Argon2id (spec 55.3), using Node's own implementation.
//
// Stored in the PHC string format, $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>,
// so each hash carries its parameters: "When hashing parameters change, the hash is
// recomputed on the next successful login" (needsRehash). The spec names Argon2id only;
// the parameters are configuration (src/config/security.config.ts).

import { argon2 } from 'node:crypto';
import { promisify } from 'node:util';
import { constantTimeEqual, randomBytes } from './crypto.util.ts';
import { AppError, refuse } from './errors.util.ts';

const argon2Async = promisify(argon2);

export interface Argon2Params {
  /** Memory in KiB. */
  memoryKiB: number;
  passes: number;
  parallelism: number;
  saltBytes: number;
  hashBytes: number;
}

// Longer input is refused before hashing, so a megabyte "password" cannot burn CPU.
export const MAX_PASSWORD_LENGTH = 1024;

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const b64 = (data: Buffer): string => data.toString('base64').replace(/=+$/, '');

interface Parsed {
  memoryKiB: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): Parsed | null {
  const match = PHC.exec(encoded);
  if (!match) return null;
  return {
    memoryKiB: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]),
    salt: Buffer.from(match[4]!, 'base64'), hash: Buffer.from(match[5]!, 'base64'),
  };
}

function checkLength(password: string): void {
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AppError('validation', 'password is too long', { code: 'password.too_long', details: { limit: MAX_PASSWORD_LENGTH } });
  }
}

async function derive(password: string, salt: Buffer, p: Pick<Argon2Params, 'memoryKiB' | 'passes' | 'parallelism'>, tagLength: number)
  : Promise<Buffer> {
  return argon2Async('argon2id', {
    message: Buffer.from(password.normalize('NFC'), 'utf8'), nonce: salt,
    memory: p.memoryKiB, passes: p.passes, parallelism: p.parallelism, tagLength,
  });
}

export async function hashPassword(password: string, params: Argon2Params): Promise<string> {
  checkLength(password);
  const salt = randomBytes(params.saltBytes);
  const hash = await derive(password, salt, params, params.hashBytes);
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

// False for a wrong password and for a stored value that is not an Argon2id hash.
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  checkLength(password);
  const parsed = parse(encoded);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed, parsed.hash.length);
  return constantTimeEqual(candidate, parsed.hash);
}

// The hasher a login endpoint uses. Each hash takes memoryKiB of memory, so at most
// maxConcurrent run at once and at most maxQueued wait; past that a caller is refused
// with a retry time (spec 12.4: every queue has a declared bound and overflow), so the
// endpoint cannot be used to exhaust memory. onHashed reports each hash's duration, to
// log and chart on the reference server.
export class PasswordHasher {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly params: Argon2Params;
  private readonly limits: { maxConcurrent: number; maxQueued: number };
  private readonly onHashed: ((durationMs: number) => void) | undefined;

  constructor(
    params: Argon2Params,
    limits: { maxConcurrent: number; maxQueued: number },
    onHashed?: (durationMs: number) => void,
  ) {
    this.params = params;
    this.limits = limits;
    this.onHashed = onHashed;
  }

  hash(password: string): Promise<string> {
    return this.limited(() => hashPassword(password, this.params));
  }

  verify(password: string, encoded: string): Promise<boolean> {
    return this.limited(() => verifyPassword(password, encoded));
  }

  needsRehash(encoded: string): boolean {
    return needsRehash(encoded, this.params);
  }

  /** Hashes running and waiting now, for a gauge. */
  load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limits.maxConcurrent) {
      if (this.waiting.length >= this.limits.maxQueued) {
        throw refuse.capacity(1, { queue: 'password_hash', limit: this.limits.maxQueued });
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.onHashed?.(Math.round(performance.now() - started));
      const next = this.waiting.shift();
      // The slot passes to the next waiter, so running stays counted.
      if (next) next();
      else this.running -= 1;
    }
  }
}

export function needsRehash(encoded: string, params: Argon2Params): boolean {
  const parsed = parse(encoded);
  return !parsed
    || parsed.memoryKiB !== params.memoryKiB || parsed.passes !== params.passes
    || parsed.parallelism !== params.parallelism || parsed.salt.length !== params.saltBytes
    || parsed.hash.length !== params.hashBytes;
}
