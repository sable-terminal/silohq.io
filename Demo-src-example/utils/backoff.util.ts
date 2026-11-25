/**
 * Retry timing, shared by jobs, connectors and self-heal.
 *
 * FULL JITTER, NOT FIXED EXPONENTIAL. Without jitter, a hundred workers that
 * failed against the same provider at the same moment all retry at the same
 * moment, and keep colliding at every doubling. The provider sees a series of
 * synchronised spikes rather than a decaying trickle — the thundering herd, which
 * is often what turns a brief outage into a long one.
 *
 * The AWS formulation: `random(0, min(cap, base · 2^n))`. Sleeping a random
 * interval up to the exponential bound spreads the herd rather than merely
 * shifting it.
 */

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  maxAttempts?: number;
}

const DEFAULTS = { baseMs: 250, capMs: 30_000, maxAttempts: 5 } as const;

/** Delay before attempt `attempt`, which is 1-indexed. */
export function delayFor(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs, capMs } = { ...DEFAULTS, ...options };
  const bound = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * bound);
}

export function shouldRetry(attempt: number, options: BackoffOptions = {}): boolean {
  return attempt < (options.maxAttempts ?? DEFAULTS.maxAttempts);
}

/**
 * `Retry-After`, which overrides our own calculation when present.
 *
 * THE PROVIDER KNOWS AND WE ARE GUESSING. Ignoring an explicit `Retry-After` in
 * favour of exponential backoff is how a rate limit becomes a ban. It accepts
 * both forms in the spec: seconds, or an HTTP date.
 */
export function parseRetryAfter(header: string | undefined | null, now = new Date()): number | null {
  if (!header) return null;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

/** The delay to use: the provider's instruction if given, otherwise ours. */
export function nextDelay(
  attempt: number,
  retryAfter: string | null | undefined,
  options: BackoffOptions = {},
): number {
  return parseRetryAfter(retryAfter) ?? delayFor(attempt, options);
}
