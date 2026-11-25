// What stands in front of a login: keyed hashes of who is asking (so a client address or
// an email address is comparable without being stored, spec 13.1) and fixed-window rate
// limits in redis-data, keyed by those hashes.

import { rateLimitKeys } from '../../infra/keyspaces.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import { keyedHash } from '../../utils/crypto.util.ts';
import { normaliseEmail } from '../../utils/email.util.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface Guard {
  addressHash(address: string | undefined): Buffer | undefined;
  userAgentHash(userAgent: string | undefined): Buffer | undefined;
  emailHash(email: string): Buffer;
  /** Counts one attempt against a limit; refuses with a retry time once it is used up. */
  limit(name: string, subject: Buffer | string, max: number, windowSeconds: number): Promise<void>;
}

export function createGuard(identifierKey: Buffer, data: RedisStore): Guard {
  return {
    addressHash: (address) => (address === undefined ? undefined : keyedHash(identifierKey, 'client_address', address)),
    userAgentHash: (userAgent) => (userAgent === undefined ? undefined : keyedHash(identifierKey, 'user_agent', userAgent)),
    emailHash: (email) => keyedHash(identifierKey, 'email', normaliseEmail(email)),
    async limit(name, subject, max, windowSeconds) {
      const key = rateLimitKeys.key({ subject: typeof subject === 'string' ? subject : subject.toString('hex'), limit: name });
      const count = await data.increment(rateLimitKeys, key, 1, { ttlSeconds: windowSeconds });
      if (count > max) {
        throw new AppError('rate_limited', 'too many attempts; wait and try again', {
          code: `auth.rate_limited.${name}`, retryAfterSeconds: windowSeconds, details: { limit: max },
        });
      }
    },
  };
}
