import { bounds, refusal } from '../../utils/error.util';
import { DEFAULT_LIMITS } from '../../utils/bounds.util';

/**
 * Every bound one read is held to, counted as it is spent.
 *
 * ── TWO CLOCKS (MANIFEST-V2 §9.7) ─────────────────────────────────────────
 *
 * An operation has sixty seconds of its own. A pipeline — an export that is
 * created, polled and downloaded — has its own ceiling, counted ACROSS the
 * sleeps between polls and checked before each one, so a job that would finish
 * after the ceiling is refused mid-wait rather than holding a worker.
 *
 * ── THE CLOCK IS INJECTED ─────────────────────────────────────────────────
 *
 * So a test can prove a job that completes after more than sixty seconds of
 * polling is read, without waiting sixty seconds.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ReadLimits {
  maxRows: number;
  maxBytes: number;
  maxRequests: number;
  operationMs: number;
}

const READ_LIMITS: ReadLimits = {
  maxRows: DEFAULT_LIMITS.maxRows,
  maxBytes: DEFAULT_LIMITS.maxBytes,
  maxRequests: 1_000,
  operationMs: DEFAULT_LIMITS.maxMilliseconds,
};

export class ReadBudget {
  rows = 0;
  bytes = 0;
  requests = 0;
  private pipelineDeadline: number | null = null;
  private pipelineSeconds = 0;

  constructor(
    readonly clock: Clock = systemClock,
    readonly limits: ReadLimits = READ_LIMITS,
  ) {}

  /** A pipeline's own ceiling, counted from now. */
  startPipeline(seconds: number): void {
    this.pipelineSeconds = seconds;
    this.pipelineDeadline = this.clock.now() + seconds * 1_000;
  }

  request(): void {
    this.requests += 1;
    if (this.requests > this.limits.maxRequests) {
      throw bounds({
        message: `Answering this took more than ${this.limits.maxRequests} requests to the source. Narrow the question.`,
        code: 'bounds.requests',
        detail: { limit: this.limits.maxRequests, observed: this.requests },
      });
    }
  }

  addBytes(count: number): void {
    this.bytes += count;
    if (this.bytes > this.limits.maxBytes) {
      throw bounds({
        message: 'The source sent more data than one question may read. Select fewer fields, or filter at the source.',
        code: 'bounds.bytes',
        detail: { limit: this.limits.maxBytes, observed: this.bytes },
      });
    }
  }

  addRows(count: number): void {
    this.rows += count;
    if (this.rows > this.limits.maxRows) {
      throw bounds({
        message: `This read returned more than ${this.limits.maxRows} rows. Narrow the date range, add a filter, or ask for a total.`,
        code: 'bounds.rows',
        detail: { limit: this.limits.maxRows, observed: this.rows },
      });
    }
  }

  /** The operation clock, checked between requests. */
  checkOperation(startedAt: number): void {
    const elapsed = this.clock.now() - startedAt;
    if (elapsed > this.limits.operationMs) {
      throw bounds({
        message: 'The source took longer than a question may wait. Reduce the range, or save this as a scheduled view.',
        code: 'bounds.time',
        detail: { limit: this.limits.operationMs, observed: elapsed },
      });
    }
  }

  /** Whether a sleep of `ms` fits inside the pipeline; refused when it would not. */
  beforeSleep(ms: number, step: string, attempts: number): void {
    if (this.pipelineDeadline === null) return;
    if (this.clock.now() + ms > this.pipelineDeadline) {
      throw refusal({
        message: `The source had not finished preparing ${step} after ${attempts} checks, and waiting longer would pass the ${this.pipelineSeconds}-second limit on one read.`,
        code: 'refusal.poll_timeout',
        detail: { step, attempts, limitSeconds: this.pipelineSeconds },
      });
    }
  }
}
