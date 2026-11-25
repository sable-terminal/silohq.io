import { DEFAULT_LIMITS, checkSources, type Limits } from '../../utils/bounds.util';
import { bounds, isAppError, type AppError } from '../../utils/error.util';
import type { Result } from './query.execution';

/**
 * Asking several systems at once.
 *
 * IN PARALLEL, AND THAT IS THE WHOLE POINT OF THIS FILE. A question that reaches
 * six systems sequentially takes the sum of six latencies; in parallel it takes
 * the slowest. For a product whose thesis is synthesis across systems, serial
 * fan-out is not a performance detail — it is the difference between an answer
 * arriving and somebody giving up.
 *
 * ── One source failing must not lose the others ─────────────────────────────
 *
 * `Promise.all` REJECTS ON THE FIRST FAILURE AND ABANDONS THE REST, which would
 * throw away five good answers because a sixth system was down. `allSettled`
 * keeps them, and the caller is told exactly which sources answered and which
 * did not.
 *
 * ── But a partial answer is still a refusal ─────────────────────────────────
 *
 * §6: exceeding bounds fires an honest refusal, never a partial answer. The same
 * holds across sources — a total computed from five of six systems is not a
 * smaller total, it is a WRONG one, and it looks exactly like a right one. So
 * results and failures are returned separately and `assertComplete` is what a
 * caller computing a figure has to go through.
 */

export interface SourceOutcome {
  connectionId: string;
  name: string;
  result: Result | null;
  error: AppError | Error | null;
}

export interface FanoutOutcome {
  answered: SourceOutcome[];
  failed: SourceOutcome[];
  /** Wall clock, which for a parallel fan-out is the slowest source. */
  durationMs: number;
}

export interface Source {
  connectionId: string;
  name: string;
  run: () => Promise<Result>;
}

/**
 * Run every source at once.
 *
 * THE SOURCE COUNT IS BOUNDED BEFORE ANYTHING RUNS. `maxSources` exists because
 * beyond a dozen the plan stops being reviewable by a person — and firing sixty
 * requests to find that out is both slow and rude to the systems on the other
 * end.
 */
export async function fanout(
  sources: Source[],
  options: { limits?: Limits; signal?: AbortSignal } = {},
): Promise<FanoutOutcome> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const started = Date.now();

  const tooMany = checkSources(sources.length, limits);
  if (tooMany) {
    throw bounds({
      message: `That question reaches ${sources.length} systems, and ${tooMany.limit} is the most a single answer may span. ${tooMany.suggestion}`.trim(),
      code: 'bounds.sources',
      detail: { observed: tooMany.observed, limit: tooMany.limit },
    });
  }

  /*
   * STARTED TOGETHER. Every `run()` is invoked before the first `await`, so the
   * network calls overlap — a loop with an await inside it would be six
   * sequential round trips wearing the shape of a parallel one.
   */
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      options.signal?.throwIfAborted();
      return { source, result: await source.run() };
    }),
  );

  const answered: SourceOutcome[] = [];
  const failed: SourceOutcome[] = [];

  settled.forEach((outcome, index) => {
    const source = sources[index]!;

    if (outcome.status === 'fulfilled') {
      answered.push({
        connectionId: source.connectionId,
        name: source.name,
        result: outcome.value.result,
        error: null,
      });
      return;
    }

    failed.push({
      connectionId: source.connectionId,
      name: source.name,
      result: null,
      error:
        outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason)),
    });
  });

  return { answered, failed, durationMs: Date.now() - started };
}

/**
 * Refuse unless every source answered.
 *
 * THE PRODUCT'S HONESTY CLAIM LIVES HERE. "It refuses and says why" means
 * nothing if a figure quietly comes from five systems out of six. The refusal
 * names the systems that did not answer and why, because a refusal without a
 * reason is indistinguishable from being broken.
 *
 * `refusal`, NOT `denial`: nobody is being kept from anything. A source was
 * unreachable, so the answer would be incomplete — retrying may well work, and
 * that is a capability signal rather than a permission one.
 */
export function assertComplete(outcome: FanoutOutcome): SourceOutcome[] {
  if (outcome.failed.length === 0) return outcome.answered;

  const reasons = outcome.failed
    .map((f) => `${f.name}: ${f.error instanceof Error ? f.error.message : 'unknown'}`)
    .join('; ');

  const first = outcome.failed[0]!.error;

  /*
   * A DENIAL FROM A SOURCE STAYS A DENIAL. If one system refused on permissions,
   * reporting that as "incomplete, try again" sends somebody to retry a query
   * that will be refused identically — the taxonomy exists so those two arrive
   * differently, and flattening every failure into a refusal loses that.
   */
  if (outcome.failed.length === 1 && isAppError(first) && first.kind === 'denial') {
    throw first;
  }

  throw bounds({
    message:
      `This answer would be incomplete: ${outcome.failed.length} of ` +
      `${outcome.answered.length + outcome.failed.length} systems did not respond. ${reasons}`,
    code: 'refusal.incomplete_sources',
    detail: { failed: outcome.failed.map((f) => f.name) },
  });
}
