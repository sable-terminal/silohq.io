import { DEFAULT_LIMITS } from '../../utils/bounds.util';
import { bounds, refusal } from '../../utils/error.util';
import { localFilters, matches, pickFields, sortLocally, type Query, type Result } from '../execution/query.execution';
import type { ReadContext } from './context.read';
import type { AggregateAsk } from './operation.read';
import { planRead, runRead } from './run.read';

/**
 * The engine, for the services: one question to one connection.
 *
 *   plan     which parts of the question the source takes (declared, or derived for SQL)
 *   fetch    run the read the document describes, bounded
 *   finish   apply the rest here, bounded
 *
 * WHAT CANNOT BE PUSHED DOWN COMES BACK AND IS BOUNDED. Exceeding the bound is
 * an honest refusal naming what happened, never a partial answer — a truncated
 * result is indistinguishable from a complete one to whoever reads the number.
 */
export async function executeRead(ctx: ReadContext, query: Query, options: { aggregate?: AggregateAsk | null } = {}): Promise<Result & { aggregate?: unknown }> {
  const started = ctx.budget.clock.now();
  if (!ctx.object.available) {
    throw refusal({
      message: `${ctx.object.name} was found on this system but has not been mapped, so it cannot be queried yet.`,
      code: 'refusal.object_unmapped',
    });
  }

  if (options.aggregate) {
    const out = await runRead(ctx, query, { want: 1, aggregate: options.aggregate });
    return { rows: [], pushedDown: out.pushed, fetched: 0, durationMs: ctx.budget.clock.now() - started, aggregate: out.aggregate };
  }

  /*
   * HOW MANY TO ASK FOR. When every filter went to the source, the caller's
   * limit is the right number. When something is applied here, asking for
   * exactly that returns fewer than asked — silently — so the read runs to the
   * bound and the refusal fires if that is not enough.
   */
  const planned = await planRead(ctx, query);
  const out = await runRead(ctx, query, { want: planned.limit ? query.limit : DEFAULT_LIMITS.maxRows });
  const pushed = out.pushed;
  const remaining = localFilters(query, pushed);

  let rows = out.rows;
  for (const filter of remaining) rows = rows.filter((row) => matches(row, filter));

  if (!pushed.limit && out.rows.length >= DEFAULT_LIMITS.maxRows) {
    throw bounds({
      message:
        `This connector cannot filter ${remaining.map((f) => f.field).join(', ')} at the source, so the whole set had to be read and it is larger than ${DEFAULT_LIMITS.maxRows} rows. ` +
        `Narrow the question, or add the filter to the connector.`,
      code: 'bounds.local_filter',
      detail: { fetched: out.rows.length, limit: DEFAULT_LIMITS.maxRows },
    });
  }

  if (!pushed.sort && query.sort.length > 0) rows = sortLocally(rows, query.sort);
  if (!pushed.limit || rows.length > query.limit) rows = rows.slice(0, query.limit);
  /*
   * THE FIELDS ASKED FOR, AND ONLY THOSE, whoever did the selecting. A source
   * that selected them still comes back through the projection, which names
   * every declared field.
   */
  if (query.fields.length > 0) rows = rows.map((row) => pickFields(row, query.fields));

  return { rows, pushedDown: pushed, fetched: out.rows.length, durationMs: ctx.budget.clock.now() - started };
}
