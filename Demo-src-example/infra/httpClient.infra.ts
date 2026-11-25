import { childLogger } from '../config/logger.config';
import { nextDelay, parseRetryAfter, shouldRetry } from '../utils/backoff.util';
import { CONNECTOR_MAX_ATTEMPTS, CONNECTOR_TIMEOUT_MS } from '../config/constants.config';

const log = childLogger('http');

/**
 * Every outbound call to somebody else's system.
 *
 * ONE CLIENT, BECAUSE THE FAILURE MODES ARE SHARED. Timeouts, retries, breakers
 * and per-host limits are not per-connector concerns — a connector written
 * without a timeout will hang a worker, and the next one written in a hurry will
 * hang it again. Centralised, the guarantee holds for connectors nobody has
 * written yet.
 *
 * A BREAKER, BECAUSE RETRYING A DEAD SYSTEM IS AN ATTACK ON IT. When a customer's
 * ERP is down, a hundred queued jobs retrying with backoff is still a hundred
 * times the normal load arriving as it tries to recover. The breaker opens after
 * repeated failures and fails fast until a probe succeeds.
 *
 * SSRF IS CHECKED HERE. Connector URLs are customer-supplied, so `http://
 * 169.254.169.254/` is a URL a customer can enter — and on a cloud host that is
 * the metadata server, which will hand out this process's own credentials.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

interface Breaker {
  state: BreakerState;
  failures: number;
  openedAt: number;
}

const FAILURE_THRESHOLD = 5;
const OPEN_MS = 30_000;

const breakers = new Map<string, Breaker>();

function breakerFor(host: string): Breaker {
  let breaker = breakers.get(host);
  if (!breaker) {
    breaker = { state: 'closed', failures: 0, openedAt: 0 };
    breakers.set(host, breaker);
  }

  if (breaker.state === 'open' && Date.now() - breaker.openedAt > OPEN_MS) {
    // One request is allowed through to test the water. If it succeeds the
    // breaker closes; if it fails the window restarts.
    breaker.state = 'half-open';
  }

  return breaker;
}

function recordSuccess(host: string): void {
  breakers.set(host, { state: 'closed', failures: 0, openedAt: 0 });
}

function recordFailure(host: string): void {
  const breaker = breakerFor(host);
  breaker.failures++;
  if (breaker.failures >= FAILURE_THRESHOLD || breaker.state === 'half-open') {
    breaker.state = 'open';
    breaker.openedAt = Date.now();
    log.warn({ host, failures: breaker.failures }, 'Circuit opened');
  }
}

/* The block list is a pure rule, kept where code with no server configuration — the agent — can read it. */
export { isBlockedHost } from '../utils/blockedHost.util';
import { isBlockedHost } from '../utils/blockedHost.util';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Set false for a call to our own infrastructure, where the guard is wrong. */
  guardSsrf?: boolean;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  attempts: number;
  durationMs: number;
}

/**
 * HOW LONG A SOURCE MAY MAKE US WAIT INSIDE ONE REQUEST.
 *
 * `retry-after` is honoured, and honouring it without a ceiling means a source
 * saying `retry-after: 3600` holds a pool connection and somebody's query open
 * for an hour. Past this point the wait stops being a retry worth hiding and
 * becomes information worth returning: "rate limited, try again in an hour" is
 * an answer, and an hour of silence is not.
 */
const RETRY_AFTER_CEILING_MS = 5_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'circuit-open' | 'timeout' | 'network' | 'status',
    readonly status?: number,
    readonly retryable = false,
    /** What the source asked us to wait, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 429 and 5xx are worth another attempt. A 4xx will fail identically forever. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

export async function request(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const target = new URL(url);

  if (options.guardSsrf !== false && isBlockedHost(target.hostname)) {
    throw new HttpError(
      `Requests to ${target.hostname} are not permitted.`,
      'blocked',
      undefined,
      false,
    );
  }

  const host = target.host;
  const breaker = breakerFor(host);
  if (breaker.state === 'open') {
    throw new HttpError(`${host} is unavailable and the circuit is open.`, 'circuit-open', undefined, true);
  }

  const maxAttempts = options.maxAttempts ?? CONNECTOR_MAX_ATTEMPTS;
  const timeout = options.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
  const startedAt = Date.now();

  let lastError: HttpError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        // Per attempt, not for the whole call. A shared deadline means the last
        // attempt gets whatever is left, which is usually nothing.
        signal: AbortSignal.timeout(timeout),
        redirect: 'manual',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      /*
       * REDIRECTS ARE NOT FOLLOWED. `redirect: 'manual'` because following one
       * re-opens the SSRF hole this closed: a permitted host answering `302
       * http://169.254.169.254/` would be followed by the runtime without ever
       * passing the guard again.
       */
      if (response.status >= 300 && response.status < 400) {
        throw new HttpError(
          `${host} returned a redirect, which is not followed.`,
          'status',
          response.status,
          false,
        );
      }

      const body = await response.text();

      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delay = nextDelay(attempt, headers['retry-after']);
        lastError = new HttpError(
          `${host} returned ${response.status}`,
          'status',
          response.status,
          true,
          parseRetryAfter(headers['retry-after']),
        );
        recordFailure(host);

        // A wait longer than a person will sit through is reported, not served.
        if (delay > RETRY_AFTER_CEILING_MS) throw lastError;

        await sleep(delay);
        continue;
      }

      recordSuccess(host);
      return {
        status: response.status,
        headers,
        body,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;

      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      lastError = new HttpError(
        timedOut ? `${host} did not respond within ${timeout}ms` : `${host} could not be reached`,
        timedOut ? 'timeout' : 'network',
        undefined,
        true,
      );
      recordFailure(host);

      if (!shouldRetry(attempt, { maxAttempts })) break;
      await sleep(nextDelay(attempt, null));
    }
  }

  throw lastError ?? new HttpError(`${host} failed`, 'network', undefined, true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** For the connector health panel. */
export function circuitState(host: string): BreakerState {
  return breakers.get(host)?.state ?? 'closed';
}

/** Tests reset breaker state between cases; nothing else should call this. */
export function resetCircuits(): void {
  breakers.clear();
}
