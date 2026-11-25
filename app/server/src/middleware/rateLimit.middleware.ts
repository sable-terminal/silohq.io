// Request rate limits on the public listeners (spec 7.3).
//
// The public API and the staff console: fixed one-minute windows in redis-data, per client
// address and per session, under each listener's own names so the two never share a count.
// The address is a keyed hash, so the key never holds it (spec 13.1). These bound what any
// one client can make the cell do; sign-in, MFA and reset attempts have their own, tighter
// limits in the auth service. Redis unreachable: the request is refused (unavailable),
// like everything else that needs redis-data; no listener runs unmetered.
//
// The directory's login listener runs on the global tier with no redis-data: a fixed
// window per address held in its process (AddressRateLimit), behind the global load
// balancer's own limit.

import type { RequestHandler } from 'express';
import type { AdminPortalConfig } from '../config/adminPortal.config.ts';
import type { GatewayConfig } from '../config/gateway.config.ts';
import { rateLimitKeys } from '../infra/keyspaces.infra.ts';
import type { RedisStore } from '../infra/redis.infra.ts';
import { keyedHash } from '../utils/crypto.util.ts';
import { AppError, refuse } from '../utils/errors.util.ts';
import { edgeClientOf } from './clientAddress.middleware.ts';
import { localsOf } from './request.middleware.ts';

export interface RequestLimiter {
  perAddress(address: string | undefined): Promise<void>;
  perSession(sessionKey: string): Promise<void>;
  /** Every session and API client of one organisation together (12.4); the staff console has none. */
  perOrganisation(organisationId: string): Promise<void>;
}

export type EdgeLimiter = RequestLimiter;
export type StaffLimiter = RequestLimiter;

interface WindowLimits {
  windowSeconds: number;
  perAddress: number;
  perSession: number;
  perOrganisation?: number;
}

function createLimiter(data: RedisStore, identifierKey: Buffer, limits: WindowLimits,
  names: { code: string; address: string; session: string }): RequestLimiter {
  const count = async (name: string, subject: string, max: number): Promise<void> => {
    const used = await data.increment(rateLimitKeys, rateLimitKeys.key({ subject, limit: name }), 1, { ttlSeconds: limits.windowSeconds });
    if (used > max) {
      throw new AppError('rate_limited', 'too many requests; wait and try again', {
        code: `${names.code}.rate_limited.${name}`, retryAfterSeconds: limits.windowSeconds, details: { limit: max },
      });
    }
  };
  return {
    async perAddress(address) {
      if (address === undefined) return;
      await count(names.address, keyedHash(identifierKey, 'client_address', address).toString('hex'), limits.perAddress);
    },
    perSession: (sessionKey) => count(names.session, sessionKey, limits.perSession),
    async perOrganisation(organisationId) {
      if (limits.perOrganisation !== undefined) await count(`${names.session}_organisation`, organisationId, limits.perOrganisation);
    },
  };
}

export const createEdgeLimiter = (data: RedisStore, identifierKey: Buffer, limits: GatewayConfig['rateLimits']): EdgeLimiter =>
  createLimiter(data, identifierKey, limits, { code: 'gateway', address: 'edge_address', session: 'edge_session' });

export const createStaffLimiter = (data: RedisStore, identifierKey: Buffer, limits: AdminPortalConfig['rateLimits']): StaffLimiter =>
  createLimiter(data, identifierKey, limits, { code: 'admin_portal', address: 'staff_address', session: 'staff_session' });

/** The limit per client address; the client is kept for the steps after. */
export function limitPerAddress(limiter: RequestLimiter, trustProxyHops: number): RequestHandler {
  return async (req, res, next) => {
    const client = edgeClientOf(req, trustProxyHops);
    localsOf(res).client = client;
    await limiter.perAddress(client.address);
    next();
  };
}

const WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 100_000;

/** A fixed one-minute window per client address, in this process. */
export class AddressRateLimit {
  private windowStart = 0;
  private readonly counts = new Map<string, number>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  /**
   * Throws a refusal naming the wait when the address is over its limit. When the table
   * of addresses is full the listener sheds load rather than forget who it limited.
   */
  take(address: string): void {
    const now = this.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.counts.clear();
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((this.windowStart + WINDOW_MS - now) / 1000));
    const count = this.counts.get(address);
    if (count === undefined && this.counts.size >= MAX_TRACKED_ADDRESSES) throw refuse.capacity(retryAfterSeconds);
    if ((count ?? 0) >= this.perMinute) {
      throw new AppError('rate_limited', 'too many requests; wait and try again', {
        code: 'login.rate_limited', retryAfterSeconds, retryable: true,
      });
    }
    this.counts.set(address, (count ?? 0) + 1);
  }
}
