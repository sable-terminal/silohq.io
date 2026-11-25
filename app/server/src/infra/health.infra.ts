// Readiness checks. Each dependency registers a check; readiness runs them all in
// parallel, each under a timeout, because "a missing health signal is a failure" (spec
// 11.2): a check that does not answer in time fails. A failure is reported by category,
// never by message.

import { describeError, type ErrorCategory } from '../utils/errors.util.ts';

export interface HealthCheck {
  name: string;
  check(signal: AbortSignal): Promise<void>;
  timeoutMs?: number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  durationMs: number;
  errorCategory?: ErrorCategory | 'timeout';
}

export class Health {
  private readonly checks: HealthCheck[] = [];

  register(check: HealthCheck): this {
    if (this.checks.some((c) => c.name === check.name)) throw new Error(`health check ${check.name} is already registered`);
    this.checks.push(check);
    return this;
  }

  async readiness(): Promise<{ ok: boolean; checks: CheckResult[] }> {
    const checks = await Promise.all(this.checks.map((c) => run(c)));
    return { ok: checks.every((c) => c.ok), checks };
  }
}

async function run(check: HealthCheck): Promise<CheckResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timeoutMs = check.timeoutMs ?? 2_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([check.check(controller.signal).then(() => 'ok' as const), timeout]);
    const durationMs = Math.round(performance.now() - started);
    return result === 'ok'
      ? { name: check.name, ok: true, durationMs }
      : { name: check.name, ok: false, durationMs, errorCategory: 'timeout' };
  } catch (error) {
    return { name: check.name, ok: false, durationMs: Math.round(performance.now() - started), errorCategory: describeError(error).errorCategory };
  } finally {
    clearTimeout(timer);
  }
}
