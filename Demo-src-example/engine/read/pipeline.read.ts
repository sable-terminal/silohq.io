import type { OperationV2, PipelineV2, StepV2 } from '../../schemas/manifest.schema';
import { bounds, refusal } from '../../utils/error.util';
import { truth, value, type Scope } from '../expression/evaluate.expression';
import type { Pushdown, Query } from '../execution/query.execution';
import type { ReadContext } from './context.read';
import { runOperation, type OperationOutput } from './operation.read';

/**
 * A READ AS A SEQUENCE OF REQUESTS (MANIFEST-V2 §3.2).
 *
 * List the ids, then fetch each one. Create an export, poll it until it is
 * ready, download the file, parse it. Each step is an operation; `steps.<name>`
 * carries what it returned to the steps after it; `records` says which of it is
 * the answer.
 *
 * ── A PARTIAL FAN-OUT IS A PARTIAL ANSWER ─────────────────────────────────
 *
 * More items than `maxItems` is refused, not cut to the first hundred; one
 * failed fetch fails the read. A list of emails with one missing looks exactly
 * like a complete one.
 *
 * ── THE PIPELINE'S CLOCK COUNTS THE WAITING ───────────────────────────────
 *
 * A poll's sleeps are counted against the pipeline's ceiling before each one
 * (§9.7). A job that would finish after it is refused mid-wait, naming the step.
 */

export interface StepResult {
  skipped?: true;
  items?: unknown[];
  results?: StepSummary[];
  response?: unknown;
  headers?: unknown;
  records: unknown[];
}

interface StepSummary {
  response: unknown;
  headers: unknown;
  records: unknown[];
}

export interface PipelineInput {
  ctx: ReadContext;
  pipeline: PipelineV2;
  merge: (op: OperationV2) => OperationV2;
  fallbackErrors: OperationV2['errors'];
  query: Query;
  plan: Pushdown;
}

export async function runPipeline(input: PipelineInput): Promise<{ records: unknown[]; steps: Record<string, StepResult> }> {
  const { ctx, pipeline } = input;
  ctx.budget.startPipeline(pipeline.maxSeconds);
  const steps: Record<string, StepResult> = {};

  for (const step of pipeline.steps) {
    const base: Scope = { params: ctx.params, steps };
    if (step.when !== undefined && !(await truth(step.when, base))) {
      steps[step.name] = { skipped: true, records: [] };
      continue;
    }

    if (step.forEach === undefined) {
      const one = await runStep(input, step, base);
      steps[step.name] = { response: one.lastResponse, headers: one.lastHeaders, records: one.records };
      continue;
    }

    const items = await value(step.forEach, base);
    if (!Array.isArray(items)) {
      if (items === null || items === undefined) {
        steps[step.name] = { items: [], results: [], records: [] };
        continue;
      }
      throw refusal({
        message: `The step ${step.name} is meant to run once per item, but what it was given is not a list.`,
        code: 'refusal.foreach_not_array',
        detail: { step: step.name },
      });
    }
    if (items.length > step.maxItems) {
      throw bounds({
        message: `The step ${step.name} would run ${items.length} times, more than the ${step.maxItems} one read allows. Narrow the first step.`,
        code: 'bounds.fan_out',
        detail: { step: step.name, observed: items.length, limit: step.maxItems },
      });
    }

    const width = Math.max(1, Math.min(step.concurrency, ctx.manifest.rateLimits.concurrency));
    const results = await mapBounded(items, width, (item) => runStep(input, step, { ...base, item }));
    steps[step.name] = {
      items,
      results: results.map((r) => ({ response: r.lastResponse, headers: r.lastHeaders, records: r.records })),
      records: results.flatMap((r) => r.records),
      response: results.at(-1)?.lastResponse ?? null,
      headers: results.at(-1)?.lastHeaders ?? {},
    };
  }

  const found = await value(pipeline.records, { params: ctx.params, steps });
  const records = Array.isArray(found) ? found : found === null || found === undefined ? [] : [found];
  ctx.observe?.(records);
  return { records, steps };
}

/** One step, once — polled when it says so. */
async function runStep(input: PipelineInput, step: StepV2, scope: Scope): Promise<OperationOutput> {
  const { ctx } = input;
  const operation = input.merge(step.operation);
  const once = (previous: unknown) =>
    runOperation({
      ctx,
      operation,
      scope: previous === undefined ? scope : { ...scope, previous },
      query: input.query,
      plan: stepPlan(input.plan, operation),
      want: operation.maxRecords,
      project: null,
      fallbackErrors: input.fallbackErrors,
    });

  if (!step.poll) return once(undefined);

  const poll = step.poll;
  const deadline = ctx.budget.clock.now() + poll.timeoutSeconds * 1_000;
  let previous: unknown = undefined;
  let attempts = 0;
  for (;;) {
    const result = await once(previous);
    attempts += 1;
    const judged: Scope = { ...scope, response: result.lastResponse, headers: result.lastHeaders as Scope['headers'], previous };
    if (await truth(poll.until, judged)) return result;

    const every = typeof poll.everySeconds === 'number' ? poll.everySeconds : Number(await value(poll.everySeconds, judged));
    const seconds = Math.min(60, Math.max(1, Number.isFinite(every) ? every : 5));
    const ms = seconds * 1_000;
    if (ctx.budget.clock.now() + ms > deadline) {
      throw refusal({
        message: `The source had not finished preparing ${step.name} after ${attempts} checks over ${poll.timeoutSeconds} seconds.`,
        code: 'refusal.poll_timeout',
        detail: { step: step.name, attempts, limitSeconds: poll.timeoutSeconds },
      });
    }
    ctx.budget.beforeSleep(ms, step.name, attempts);
    await ctx.budget.clock.sleep(ms);
    previous = result.lastResponse;
  }
}

/** A step renders only the filters its own operation declares. */
function stepPlan(plan: Pushdown, operation: OperationV2): Pushdown {
  const pd = operation.pushdown;
  return {
    filters: plan.filters.filter((f) => pd?.filters[f.field]?.[f.op] !== undefined),
    sort: false,
    limit: false,
    fields: false,
  };
}

/** `map` with at most `width` in flight. The first failure fails all of it. */
async function mapBounded<T, R>(items: T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < items.length) {
      const at = next++;
      try {
        out[at] = await run(items[at]!);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (failed !== null) throw failed;
  return out;
}
