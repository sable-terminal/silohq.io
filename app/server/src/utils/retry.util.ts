// Retries with exponential backoff and full jitter. "Callers retry under idempotency
// keys" (spec 7.1): retry an operation only when repeating it is safe, which for a write
// means it carries an idempotency key.

import { randomUUID } from 'node:crypto';
import { isAppError } from './errors.util.ts';
import { sleep } from './time.util.ts';

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Whether an error is worth another attempt. Default: an AppError marked retryable. */
  retryable?: (error: unknown) => boolean;
  signal?: AbortSignal;
  /** Called before each wait; for metrics. Never log the error's message. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const defaultRetryable = (error: unknown): boolean => isAppError(error) && error.retryable;

export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const retryable = options.retryable ?? defaultRetryable;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.attempts || !retryable(error) || options.signal?.aborted) throw error;
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      // A capacity refusal names its retry time (spec 12.4); never retry sooner.
      const floor = isAppError(error) && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : 0;
      const delayMs = Math.max(floor, Math.floor(Math.random() * ceiling));
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs, options.signal);
    }
  }
}

// An idempotency key for a call the caller may repeat. Keep it with the work, so a retry
// sends the same key.
export function idempotencyKey(): string {
  return randomUUID();
}
