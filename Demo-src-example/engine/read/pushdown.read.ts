import type { ObjectV2, OperationV2, PipelineV2, PushdownV2 } from '../../schemas/manifest.schema';
import { refusal } from '../../utils/error.util';
import { deep, every, path as pathOf, value, type Scope } from '../expression/evaluate.expression';
import { recordKeysRead } from '../expression/lint.expression';
import type { Filter, Pushdown, Query } from '../execution/query.execution';
import { mergeDeep, mergeMap } from './merge.read';

/**
 * What the source will do for a question, and writing it into the request.
 *
 * ── DECLARED PER FIELD AND OPERATOR, NEVER PROBED ─────────────────────────
 *
 * A filter is pushed only when the operation declares a template for exactly
 * that field and that operator. Everything else comes back and is filtered here,
 * inside the read's bounds. A limit is pushed only when EVERY filter was —
 * asking the source for ten and discarding six returns four, silently.
 *
 * ── ONE ORDER, AND COMPOSE LAST ───────────────────────────────────────────
 *
 * filters → sort → limit → fields → compose (MANIFEST-V2 §9.4). SOQL, JQL and
 * QuickBooks write the whole question into one parameter, so `compose` runs
 * once, with `fragments`, `order`, `limit` and `fields` all bound.
 */

/** A value reaching a query language may be at most this long (§9.4). */
const MAX_FRAGMENT_VALUE = 1_000;

const templateFor = (pd: PushdownV2 | undefined, filter: Filter) => pd?.filters[filter.field]?.[filter.op];

function inTooMany(pd: PushdownV2 | undefined, filter: Filter): boolean {
  if (!pd || pd.maxFilterValues === 0 || filter.op !== 'in') return false;
  return Array.isArray(filter.value) && filter.value.length > pd.maxFilterValues;
}

/** What one operation takes from a question. */
export function planOperation(object: ObjectV2, operation: OperationV2, query: Query): Pushdown {
  const pd = operation.pushdown;
  const names = new Set(object.fields.map((f) => f.name));
  const filters = query.filters.filter((f) => templateFor(pd, f) !== undefined && !inTooMany(pd, f));
  return {
    filters,
    /*
     * ONLY FIELDS THE SOURCE HOLDS. A field computed from others — `amount`
     * from `amount_pence` — has no order at the source, so asking it to sort
     * by one returns the source's order dressed up as the one asked for.
     */
    sort: !!pd?.sort && query.sort.length > 0 && query.sort.every((s) => names.has(s.field) && columnOf(operation, s.field) !== null),
    limit: !!pd?.limit && filters.length === query.filters.length,
    fields: !!pd?.fields && query.fields.length > 0,
  };
}

/**
 * What a pipeline takes: a filter declared on ANY step is rendered into that
 * step. Sort and limit are never claimed, because the records a pipeline returns
 * are assembled from several requests and no one of them orders or counts them.
 */
export function planPipeline(pipeline: PipelineV2, query: Query): Pushdown {
  const filters = query.filters.filter((f) =>
    pipeline.steps.some((s) => templateFor(s.operation.pushdown, f) !== undefined && !inTooMany(s.operation.pushdown, f)),
  );
  return { filters, sort: false, limit: false, fields: false };
}

/** The parts of a request pushdown may change. */
export interface Patchable {
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  path: string | null;
  search: unknown;
  where: Array<{ column: string; operator: string; value: unknown }>;
}

export interface Rendered {
  fragments: unknown[];
  order: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit: number | null;
  fields: string[];
}

async function applyPatch(
  target: Patchable,
  patch: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; path?: string; search?: unknown } | undefined,
  scope: Scope,
): Promise<void> {
  if (!patch) return;
  if (patch.query) target.query = mergeMap(target.query, await every(patch.query, scope, { keepNull: true }));
  if (patch.headers) target.headers = mergeMap(target.headers, await every(patch.headers, scope, { keepNull: true }));
  if (patch.body !== undefined) target.body = mergeDeep(target.body, await deep(patch.body, scope));
  if (patch.path !== undefined) target.path = await pathOf(patch.path, scope);
  if (patch.search !== undefined) target.search = mergeDeep(target.search, await deep(patch.search, scope));
}

/**
 * Write the planned pushdown into a request, in the one order.
 *
 * Returns what `compose`, paging and state initialisation see.
 */
export async function renderPushdown(input: {
  target: Patchable;
  pushdown: PushdownV2 | undefined;
  object: ObjectV2;
  plan: Pushdown;
  query: Query;
  want: number;
  maxRecords: number;
  params: Record<string, string>;
}): Promise<Rendered> {
  const { target, pushdown: pd, plan, query, params } = input;
  const fragments: unknown[] = [];
  const rendered: Rendered = {
    fragments,
    order: plan.sort ? query.sort : [],
    /*
     * ONE MORE THAN THE CEILING, WHEN MORE THAN THE CEILING IS WANTED. Asking a
     * source for exactly `maxRecords` rows gets exactly that many back, and a
     * table holding eight thousand reads as one holding five — every figure
     * over it computed from a part, with nothing to say so. One row past the
     * ceiling is what lets the read refuse instead (`ceiling`).
     */
    limit: plan.limit ? Math.min(input.want, input.maxRecords + 1) : null,
    fields: plan.fields ? [...new Set([...input.object.identifier, ...query.fields])] : [],
  };
  if (!pd) return rendered;

  let pushedAny = false;
  for (const filter of plan.filters) {
    const template = templateFor(pd, filter);
    if (!template) continue;
    if (typeof filter.value === 'string' && filter.value.length > MAX_FRAGMENT_VALUE && template.fragment !== undefined) {
      throw refusal({
        message: `A value of more than ${MAX_FRAGMENT_VALUE} characters cannot be written into this source's query language.`,
        code: 'refusal.filter_value_too_long',
        detail: { field: filter.field },
      });
    }
    pushedAny = true;
    const scope: Scope = { field: filter.field, op: filter.op, value: filter.value ?? null, params };
    await applyPatch(target, template, scope);
    if (template.fragment !== undefined) fragments.push(await deep(template.fragment, scope));
    if (template.where) {
      const worked = template.where.value !== undefined ? await value(template.where.value, scope) : filter.value;
      target.where.push({ column: template.where.column, operator: template.where.operator ?? filter.op, value: worked ?? null });
    }
  }

  const bound: Scope = { params, fragments, order: rendered.order, limit: rendered.limit, fields: rendered.fields };
  if (plan.sort && pd.sort) {
    pushedAny = true;
    await applyPatch(target, pd.sort, bound);
  }
  if (plan.limit && pd.limit) {
    pushedAny = true;
    await applyPatch(target, pd.limit, bound);
  }
  if (plan.fields && pd.fields) {
    pushedAny = true;
    await applyPatch(target, pd.fields, bound);
  }
  const compose = pd.compose ?? pd.combine;
  if (compose && pushedAny) await applyPatch(target, compose, bound);

  return rendered;
}

/** A total without the rows: applied after compose, with the filtered set's fragments bound. */
export async function renderAggregate(input: {
  target: Patchable;
  pushdown: PushdownV2 | undefined;
  kind: 'count' | 'sum' | 'group_by';
  field: string | null;
  by: string | null;
  rendered: Rendered;
  params: Record<string, string>;
}): Promise<{ value: string; records?: string; key?: string } | null> {
  const declared = input.pushdown?.aggregates?.[input.kind];
  if (!declared) return null;
  const scope: Scope = {
    params: input.params,
    fragments: input.rendered.fragments,
    ...(input.field ? { field: input.field } : {}),
    ...(input.by ? { by: input.by } : {}),
  };
  await applyPatch(input.target, declared.request, scope);
  return 'records' in declared
    ? { value: declared.value, records: declared.records, key: declared.key }
    : { value: declared.value };
}

/* ── SQL: derived, not declared ────────────────────────────────────────── */

const SIMPLE_COLUMN = /^\{\{\s*([A-Za-z_][A-Za-z0-9_$#]*)\s*\}\}$/;

/**
 * The column a field IS, when it is one: no expression, or an expression that
 * only renames. A field computed from columns is not a column, so a filter on
 * it is applied here rather than guessed into a WHERE.
 */
export function columnOf(operation: OperationV2, field: string): string | null {
  const expression = operation.fields[field];
  if (expression === undefined) return field;
  const match = SIMPLE_COLUMN.exec(expression);
  return match ? match[1]! : null;
}

/** Every column a set of fields needs: the ones they are, and the ones their expressions read. */
export function columnsFor(operation: OperationV2, fields: string[]): string[] {
  const out = new Set<string>();
  for (const field of fields) {
    const direct = columnOf(operation, field);
    if (direct) out.add(direct);
    else for (const key of recordKeysRead(operation.fields[field]!)) out.add(key);
  }
  return [...out];
}

/**
 * What a database takes from a question: every filter on a field that is a
 * column, the order when every sort field is one, the limit when every filter
 * went, the field list whenever one is asked for. A connector that declared
 * filters keeps exactly those (a v1 document that restricted them).
 */
export function planSql(object: ObjectV2, operation: OperationV2, query: Query, operators?: ReadonlySet<string>): Pushdown {
  const declared = operation.pushdown?.filters;
  const restricted = declared && Object.keys(declared).length > 0;
  const filters = query.filters.filter((f) => {
    if (inTooMany(operation.pushdown, f)) return false;
    if (operators && !operators.has(f.op)) return false;
    if (restricted) return declared[f.field]?.[f.op] !== undefined;
    return object.fields.some((field) => field.name === f.field) && columnOf(operation, f.field) !== null;
  });
  return {
    filters,
    sort: query.sort.length > 0 && query.sort.every((s) => columnOf(operation, s.field) !== null),
    limit: filters.length === query.filters.length,
    fields: query.fields.length > 0,
  };
}

export async function renderSql(input: {
  target: Patchable;
  operation: OperationV2;
  object: ObjectV2;
  plan: Pushdown;
  query: Query;
  want: number;
  params: Record<string, string>;
}): Promise<Rendered & { columns: string[] }> {
  const { operation: op, plan, query } = input;
  for (const f of plan.filters) {
    const template = op.pushdown?.filters[f.field]?.[f.op];
    if (template?.where) {
      const scope: Scope = { field: f.field, op: f.op, value: f.value ?? null, params: input.params };
      const worked = template.where.value !== undefined ? await value(template.where.value, scope) : f.value;
      input.target.where.push({ column: template.where.column, operator: template.where.operator ?? f.op, value: worked ?? null });
    } else {
      input.target.where.push({ column: columnOf(op, f.field)!, operator: f.op, value: f.value ?? null });
    }
  }
  const all = input.object.fields.map((f) => f.name);
  const wanted = plan.fields ? [...new Set([...input.object.identifier, ...query.fields])] : all;
  return {
    fragments: [],
    order: plan.sort ? query.sort.map((s) => ({ field: columnOf(op, s.field)!, direction: s.direction })) : [],
    /* One past the ceiling either way, so a table larger than it is refused rather than read short. */
    limit: plan.limit ? Math.min(input.want, op.maxRecords + 1) : op.maxRecords + 1,
    fields: plan.fields ? columnsFor(op, wanted) : [],
    columns: columnsFor(op, all),
  };
}

/** What Silo's own row store can filter on: everything a database can, but containment. */
export const ROW_STORE_OPERATORS: ReadonlySet<string> = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null']);
