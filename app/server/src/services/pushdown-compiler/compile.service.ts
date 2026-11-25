// The pushdown compiler (catalogue: pushdown-compiler; spec 14.5): a plan step into what the
// source computes, using only what the manifest declares, and what the engine computes
// after, bounded. Nothing is assumed: an operator the manifest does not declare for a field
// is residual. Declared pushdown is verified by the conformance suite (spec 17.2).
//
// - A filter is native when the manifest declares its field and operator.
// - Sort is native only as a whole: every key declared, and the aggregate (if any) native.
// - A limit is native only when nothing residual could change which rows it keeps: no
//   residual filter, a native or absent sort, a native or absent aggregate.
// - An aggregate is native only on the SQL engine, when the manifest declares every function
//   and grouping, and every filter is native.
// For REST, the native part becomes request patches, each from the manifest's CEL
// expression for that field and operator; the SQL engine compiles its native part itself.

import type { FailingOperator } from '../../contracts/conformance/conformance.contract.ts';
import type { Manifest, ManifestObject, RequestPatch } from '../../contracts/connect/manifest.contract.ts';
import type { PlanStep, PushdownSplit, StepFilter } from '../../contracts/connect/step.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';

/**
 * The manifest without the pushdown that failed conformance (spec 17.2: a failing operator is
 * removed from the version). What is removed is computed after the source, bounded.
 */
export function withoutFailing(manifest: Manifest, failing: readonly FailingOperator[]): Manifest {
  if (failing.length === 0) return manifest;
  const fails = (object: string, field: string, op: string) => failing.some((f) => f.object === object && f.field === field && f.op === op);
  return {
    ...manifest,
    objects: manifest.objects.map((o) => {
      const filters = o.pushdown.filters
        .map((f) => ({ ...f, ops: f.ops.filter((op) => !fails(o.name, f.field, op)) }))
        .filter((f) => f.ops.length > 0);
      const sort = o.pushdown.sort.filter((s) => !fails(o.name, s.field, 'sort'));
      const functions = o.pushdown.aggregates?.functions.filter((fn) => !failing.some((f) => f.object === o.name && f.op === fn)) ?? [];
      const { aggregates: _aggregates, ...rest } = o.pushdown;
      return { ...o, pushdown: { ...rest, filters, sort, ...(o.pushdown.aggregates && functions.length > 0 ? { aggregates: { ...o.pushdown.aggregates, functions } } : {}) } };
    }),
  };
}

export function objectOf(manifest: Manifest, name: string): ManifestObject {
  const object = manifest.objects.find((o) => o.name === name);
  if (!object) throw new AppError('validation', 'the connector has no such object', { code: 'step.object_unknown', details: { object: name } });
  return object;
}

function checkFields(object: ManifestObject, step: PlanStep): void {
  const fields = new Set(object.fields.map((f) => f.name));
  const aliases = new Set(step.aggregate?.measures.map((m) => m.as) ?? []);
  const unknown = (field: string) => new AppError('validation', 'the step names a field the object does not have', {
    code: 'step.field_unknown', details: { field },
  });
  for (const f of step.fields ?? []) if (!fields.has(f)) throw unknown(f);
  for (const f of step.filters) if (!fields.has(f.field)) throw unknown(f.field);
  for (const g of step.aggregate?.groupBy ?? []) if (!fields.has(g)) throw unknown(g);
  for (const m of step.aggregate?.measures ?? []) if (m.field !== undefined && !fields.has(m.field)) throw unknown(m.field);
  for (const s of step.sort) if (!fields.has(s.field) && !aliases.has(s.field)) throw unknown(s.field);
}

export function splitPushdown(manifest: Manifest, object: ManifestObject, step: PlanStep): PushdownSplit {
  checkFields(object, step);
  const declared = object.pushdown;
  const nativeFilters: StepFilter[] = [];
  const residualFilters: StepFilter[] = [];
  for (const filter of step.filters) {
    const rule = declared.filters.find((f) => f.field === filter.field && f.ops.includes(filter.op));
    (rule ? nativeFilters : residualFilters).push(filter);
  }

  const aggregate = step.aggregate ?? null;
  const aggregateNative = aggregate !== null && manifest.protocol.kind === 'sql' && declared.aggregates !== undefined
    && residualFilters.length === 0
    && aggregate.measures.every((m) => declared.aggregates!.functions.includes(m.fn))
    && (aggregate.groupBy.length === 0 || declared.aggregates.groupBy);

  const sortable = new Set(declared.sort.map((s) => s.field));
  const sortNative = step.sort.length > 0 && (aggregate === null
    ? step.sort.every((s) => sortable.has(s.field))
    : aggregateNative);

  const limit = step.limit ?? null;
  const limitNative = limit !== null && residualFilters.length === 0 && (step.sort.length === 0 || sortNative)
    && (aggregate === null || aggregateNative);

  return {
    native: {
      filters: nativeFilters,
      sort: sortNative ? step.sort : [],
      limit: limitNative ? limit : null,
      aggregate: aggregateNative ? aggregate : null,
    },
    residual: {
      filters: residualFilters,
      sort: sortNative ? [] : step.sort,
      limit: limitNative ? null : limit,
      aggregate: aggregate !== null && !aggregateNative ? aggregate : null,
    },
  };
}

/** REST: the request patches for the native part, from the manifest's expressions. */
export async function restPatches(object: ManifestObject, native: PushdownSplit['native'], params: Record<string, string>, now: Date)
  : Promise<RequestPatch[]> {
  const patches: RequestPatch[] = [];
  for (const filter of native.filters) {
    const rule = object.pushdown.filters.find((f) => f.field === filter.field && f.ops.includes(filter.op))!;
    patches.push(await compileExpression('pushdown.filter', 'cel', rule.patch!.cel)
      .evaluate({ field: filter.field, op: filter.op, value: filter.value ?? null, params }, now) as RequestPatch);
  }
  for (const sort of native.sort) {
    const rule = object.pushdown.sort.find((s) => s.field === sort.field)!;
    patches.push(await compileExpression('pushdown.sort', 'cel', rule.patch!.cel)
      .evaluate({ field: sort.field, direction: sort.direction, params }, now) as RequestPatch);
  }
  if (native.limit !== null && object.pushdown.limit?.patch !== undefined) {
    patches.push(await compileExpression('pushdown.limit', 'cel', object.pushdown.limit.patch.cel)
      .evaluate({ limit: native.limit, params }, now) as RequestPatch);
  }
  return patches;
}
