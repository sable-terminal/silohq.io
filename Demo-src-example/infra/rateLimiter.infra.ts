import { increment, isAvailable, isConfigured } from './cache.infra';
import { childLogger } from '../config/logger.config';

const log = childLogger('rate-limit');

/**
 * Token buckets, held in the cache so every instance shares one count.
 *
 * IN REDIS AND NOT IN MEMORY, because a per-process limit is not a limit. With
 * four instances behind a load balancer, an in-memory limit of twenty is a limit
 * of eighty — and it changes whenever the deployment scales, which makes it
 * something nobody can reason about.
 *
 * TWO DIRECTIONS OF FAILURE, AND THEY ARE NOT THE SAME. When the cache is
 * unavailable, a request limiter must fail OPEN — taking the product down because
 * a cache is down is a worse outcome than briefly unlimited requests. A login
 * limiter must fail CLOSED, because failing open on authentication turns a cache
 * outage into an open brute-force window. The caller says which, and it has to.
 *
 * "UNAVAILABLE" MEANS CONFIGURED AND NOT ANSWERING — NOT "NEVER CONFIGURED".
 * The first version treated them alike, and the result was that a machine with
 * no `REDIS_URL` refused every login and every registration with a 429: the
 * whole product was unreachable on a developer's laptop, and a deploy that
 * mislaid the variable would have looked like an abuse spike rather than a
 * misconfiguration. Production cannot reach that branch — `assertProductionReady`
 * refuses to boot without `REDIS_URL` — so an unconfigured cache is by
 * construction a development posture, and the fail-closed rule still holds
 * wherever it can actually matter.
 */

export type FailureMode = 'open' | 'closed';

export interface LimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Seconds until the window resets. For a `Retry-After` header. */
  retryAfterSeconds: number;
  /** True when the decision was made without a working cache. */
  degraded: boolean;
}

export async function check(input: {
  kind: string;
  subject: string;
  limit: number;
  windowSeconds: number;
  onUnavailable: FailureMode;
}): Promise<LimitResult> {
  if (!isAvailable()) {
    const configured = isConfigured();
    const allowed = input.onUnavailable === 'open' || !configured;

    if (!allowed) {
      log.error(
        { kind: input.kind },
        'The cache is configured but unreachable and this limit fails closed. Requests are being refused.',
      );
    } else if (!configured) {
      log.warn(
        { kind: input.kind },
        'No cache is configured, so nothing is being counted. Development only.',
      );
    }
    return {
      allowed,
      count: 0,
      limit: input.limit,
      retryAfterSeconds: input.windowSeconds,
      degraded: true,
    };
  }

  const count = await increment(
    { plane: 'control', kind: `ratelimit:${input.kind}`, parts: [input.subject] },
    input.windowSeconds,
  );

  return {
    allowed: count <= input.limit,
    count,
    limit: input.limit,
    retryAfterSeconds: input.windowSeconds,
    degraded: false,
  };
}

/**
 * Per-connection limiting, respecting what the provider said.
 *
 * A PROVIDER'S OWN LIMIT IS AUTHORITATIVE AND OURS IS A GUESS. When a response
 * carries `X-RateLimit-Remaining: 0` or a `Retry-After`, that is the real limit;
 * continuing to send because our counter says there is room is how a rate limit
 * becomes a suspended account. This records the provider's answer so the next
 * caller waits.
 */
const providerCooldowns = new Map<string, number>();

export function recordProviderLimit(connectionId: string, retryAfterMs: number): void {
  providerCooldowns.set(connectionId, Date.now() + retryAfterMs);
}

export function providerCooldownRemaining(connectionId: string): number {
  const until = providerCooldowns.get(connectionId);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    providerCooldowns.delete(connectionId);
    return 0;
  }
  return remaining;
}
