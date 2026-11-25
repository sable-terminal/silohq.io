// A plan step against one source object: what the planner asks connect-runtime to read,
// and what the pushdown compiler splits into the part the source computes (native) and
// the part the engine computes after, bounded (residual). Field names are the manifest's.

import { z } from 'zod';
import { AGGREGATE_FUNCTIONS, FILTER_OPS } from './manifest.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const scalar = z.union([z.string().max(4_096), z.number(), z.boolean()]);

export const stepFilter = z.strictObject({
  field: name,
  op: z.enum(FILTER_OPS),
  /** A scalar; a non-empty list for in; absent for is_null and is_not_null. */
  value: z.union([scalar, z.array(scalar).min(1).max(1_000)]).optional(),
}).superRefine((f, ctx) => {
  const list = Array.isArray(f.value);
  if ((f.op === 'is_null' || f.op === 'is_not_null') !== (f.value === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'a null check has no value; every other operator has one' });
  } else if ((f.op === 'in') !== list && f.value !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'in takes a list; every other operator a scalar' });
  }
});
export type StepFilter = z.infer<typeof stepFilter>;

export const stepSort = z.strictObject({ field: name, direction: z.enum(['asc', 'desc']).default('asc') });
export type StepSort = z.infer<typeof stepSort>;

export const stepAggregate = z.strictObject({
  groupBy: z.array(name).max(10).default([]),
  measures: z.array(z.strictObject({
    fn: z.enum(AGGREGATE_FUNCTIONS),
    /** Absent only for count, which counts rows. */
    field: name.optional(),
    as: name,
  })).min(1).max(20),
}).superRefine((a, ctx) => {
  a.measures.forEach((m, i) => {
    if (m.fn !== 'count' && m.field === undefined) ctx.addIssue({ code: 'custom', path: ['measures', i, 'field'], message: `${m.fn} needs a field` });
  });
});
export type StepAggregate = z.infer<typeof stepAggregate>;

export const planStep = z.strictObject({
  object: name,
  /** The fields to return; all when absent. Ignored with an aggregate. */
  fields: z.array(name).min(1).max(2_000).optional(),
  filters: z.array(stepFilter).max(50).default([]),
  sort: z.array(stepSort).max(10).default([]),
  limit: z.int().min(1).max(1_000_000).optional(),
  aggregate: stepAggregate.optional(),
});
export type PlanStep = z.output<typeof planStep>;
export type PlanStepInput = z.input<typeof planStep>;

/** What the source computes and what the engine computes after it. */
export const pushdownSplit = z.object({
  native: z.object({
    filters: z.array(stepFilter),
    sort: z.array(stepSort),
    limit: z.int().nullable(),
    aggregate: stepAggregate.nullable(),
  }),
  residual: z.object({
    filters: z.array(stepFilter),
    sort: z.array(stepSort),
    limit: z.int().nullable(),
    aggregate: stepAggregate.nullable(),
  }),
});
export type PushdownSplit = z.infer<typeof pushdownSplit>;
