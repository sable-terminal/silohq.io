import type { OperationV2, PipelineV2, ReadV2, ManifestV2 } from '../../schemas/manifest.schema';
import { isPipeline, isVariants } from '../../schemas/manifest.schema';
import { bounds } from '../../utils/error.util';
import { truth, value, type Scope } from '../expression/evaluate.expression';
import type { Pushdown, Query } from '../execution/query.execution';
import type { ReadContext } from './context.read';
import { mergeDeep, mergeMap } from './merge.read';
import { runOperation, type AggregateAsk } from './operation.read';
import { runPipeline } from './pipeline.read';
import { planOperation, planPipeline, planSql, ROW_STORE_OPERATORS } from './pushdown.read';
import { listedValue } from '../discovery/fields.discovery';

/**
 * A read of one object, whatever shape the connector gave it.
 *
 * `read` IS AN OPERATION, A PIPELINE, OR A LIST OF VARIANTS. Variants are for a
 * source that reads differently depending on the question (finding F35): the
 * first whose `when` holds over `{ filters, order, limit, fields }` runs, and
 * the last, with no `when`, is the default.
 */

export interface ReadResult {
  rows: Array<Record<string, unknown>>;
  pushed: Pushdown;
  /** How many records the source sent, before anything was filtered here. */
  fetched: number;
  pages: number;
  requests: number;
  /** An aggregate the source computed, when one was asked for and declared. */
  aggregate?: unknown;
}

/**
 * What the source will be asked, before anything is sent: which read runs and
 * what of the question it takes. No I/O, so a caller can size the read by it.
 */
export async function planRead(ctx: ReadContext, query: Query): Promise<Pushdown> {
  const chosen = await chooseRead(ctx.object.read, query);
  if (isPipeline(chosen)) return planPipeline(chosen, query);
  const operation = withDefaults(ctx.manifest.defaults, chosen);
  return derives(ctx) ? planSql(ctx.object, operation, query, operatorsOf(ctx)) : planOperation(ctx.object, operation, query);
}

export async function runRead(ctx: ReadContext, query: Query, options: { want: number; aggregate?: AggregateAsk | null }): Promise<ReadResult> {
  const chosen = await chooseRead(ctx.object.read, query);
  const merge = (op: OperationV2) => withDefaults(ctx.manifest.defaults, op);
  const fallbackErrors = [...ctx.manifest.defaults.errors, ...ctx.manifest.errors];

  try {
    if (isPipeline(chosen)) {
      const plan = planPipeline(chosen, query);
      const { records, steps } = await runPipeline({ ctx, pipeline: chosen, merge, fallbackErrors, query, plan });
      if (records.length > chosen.maxRecords) {
        throw bounds({
          message: `There are more than ${chosen.maxRecords} ${ctx.object.name} records to read for this question. Filter at the source, or ask for a total.`,
          code: 'bounds.read_ceiling',
          detail: { limit: chosen.maxRecords },
        });
      }
      const rows = await projectPipeline(ctx, chosen, records, steps);
      ctx.budget.addRows(rows.length);
      return { rows: rows.slice(0, options.want), pushed: plan, fetched: records.length, pages: 0, requests: ctx.budget.requests };
    }

    const operation = merge(chosen);
    const plan = derives(ctx) ? planSql(ctx.object, operation, query, operatorsOf(ctx)) : planOperation(ctx.object, operation, query);
    const out = await runOperation({
      ctx,
      operation,
      scope: {},
      query,
      plan,
      want: options.want,
      project: { object: ctx.object, fields: operation.fields, strict: operation.strictFields },
      aggregate: options.aggregate ?? null,
      fallbackErrors,
    });
    return {
      rows: out.records as Array<Record<string, unknown>>,
      pushed: plan,
      fetched: out.records.length,
      pages: out.pages,
      requests: out.requests,
      ...(options.aggregate ? { aggregate: out.aggregate } : {}),
    };
  } finally {
    ctx.blobs.clear();
  }
}

/** A database and a Silo import take the whole question, so what they push down is derived. */
const derives = (ctx: ReadContext) => ctx.manifest.transport.kind === 'sql' || ctx.manifest.transport.kind === 'silo_import';

const operatorsOf = (ctx: ReadContext) => (ctx.manifest.transport.kind === 'silo_import' ? ROW_STORE_OPERATORS : undefined);

/** Which variant answers this question. */
export async function chooseRead(read: ReadV2, query: Query): Promise<OperationV2 | PipelineV2> {
  if (!isVariants(read)) return read;
  const scope: Scope = {
    filters: query.filters.map((f) => ({ field: f.field, op: f.op, value: f.value ?? null })),
    order: query.sort,
    limit: query.limit,
    fields: query.fields,
  };
  for (const variant of read) {
    const { when, ...rest } = variant as (OperationV2 | PipelineV2) & { when?: string };
    if (when === undefined || (await truth(when, scope))) return rest as OperationV2 | PipelineV2;
  }
  const last = read.at(-1) as (OperationV2 | PipelineV2) & { when?: string };
  const { when: _when, ...rest } = last;
  return rest as OperationV2 | PipelineV2;
}

/**
 * The manifest's defaults UNDER an operation: the operation wins wherever it
 * speaks. Maps merge per key, trees merge deep, lists are the operation's. A
 * field the schema defaults (`format: auto`) counts as silent.
 */
export function withDefaults(defaults: ManifestV2['defaults'], op: OperationV2): OperationV2 {
  return {
    ...op,
    request: {
      ...op.request,
      params: mergeMap(defaults.params, op.request.params),
    },
    format: op.format === 'auto' && defaults.format ? defaults.format : op.format,
    charset: op.charset === 'auto' && defaults.charset ? defaults.charset : op.charset,
    formatOptions: { ...(defaults.formatOptions ?? {}), ...op.formatOptions },
    page: op.page ?? defaults.page,
    pushdown: defaults.pushdown && op.pushdown ? (mergeDeep(defaults.pushdown, op.pushdown) as OperationV2['pushdown']) : op.pushdown ?? defaults.pushdown,
    maxRecords: op.maxRecords === 5_000 && defaults.maxRecords ? defaults.maxRecords : op.maxRecords,
  };
}

async function projectPipeline(
  ctx: ReadContext,
  pipeline: PipelineV2,
  records: unknown[],
  steps: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const declared = ctx.object.fields.map((f) => f.name);
  const plain = (r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r);
  const out: Array<Record<string, unknown>> = [];
  for (const [index, record] of records.entries()) {
    const row: Record<string, unknown> = !pipeline.strictFields && plain(record) ? { ...record } : {};
    const names = pipeline.strictFields ? declared : [...new Set([...declared, ...Object.keys(pipeline.fields)])];
    for (const name of names) {
      const expression = pipeline.fields[name];
      if (expression === undefined) {
        /* As for one operation: a declared, unmapped field is read by the field list's value expression. */
        const declared = ctx.object.fieldList ? ctx.object.fields.find((one) => one.name === name) : undefined;
        row[name] = declared
          ? await listedValue(ctx.object.fieldList!.value, declared, { record, params: ctx.params, steps, index, row: index + 1 })
          : plain(record) && record[name] !== undefined
            ? record[name]
            : null;
        continue;
      }
      const worked = await value(expression, { record, params: ctx.params, steps, index, row: index + 1 });
      row[name] = worked === undefined ? null : worked;
    }
    out.push(row);
  }
  return out;
}
