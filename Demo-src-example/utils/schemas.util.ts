import { z } from 'zod';

/**
 * Every boundary schema, in one file.
 *
 * THE MANIFEST SCHEMA IS THE SECURITY BOUNDARY BETWEEN THE MODEL AND THE ENGINE.
 * A model proposes a query; this decides whether the proposal is even the right
 * shape to consider. Everything downstream — the pushdown, the field policies,
 * the bounds — assumes it is operating on a validated manifest, so a gap here is
 * a gap in all of them.
 *
 * IT IS A CLOSED SHAPE: `.strict()` EVERYWHERE. Zod strips unknown keys by
 * default, which silently discards a field a model invented. Rejecting instead
 * means a model producing something unexpected is a visible failure rather than a
 * query that quietly does less than it appears to.
 *
 * IT VALIDATES SHAPE ONLY. Whether the connections exist and the fields are
 * permitted is `manifestValidator`, which needs the tenant's catalogue.
 */

export const uuid = z.string().uuid();
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

/** A field path as the source names it: `invoice.total`, `Account.Owner.Name`. */
export const fieldPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'Not a field path');

export const comparisonOperator = z.enum([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null',
]);

/**
 * A filter.
 *
 * THE VALUE IS A LITERAL, NEVER AN EXPRESSION. The moment a filter can carry a
 * fragment the source system will evaluate, the manifest becomes an injection
 * vector into somebody's ERP. Literals and lists of literals only.
 */
export const filter = z
  .object({
    field: fieldPath,
    operator: comparisonOperator,
    value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]).optional(),
  })
  .strict();

export const aggregation = z
  .object({
    function: z.enum(['sum', 'count', 'avg', 'min', 'max', 'count_distinct']),
    field: fieldPath.optional(),
    alias: z.string().min(1).max(64),
  })
  .strict();

/** One source's part of the plan. */
export const sourceQuery = z
  .object({
    connectionId: uuid,
    object: z.string().min(1).max(128),
    fields: z.array(fieldPath).min(1).max(200),
    filters: z.array(filter).max(50).default([]),
    aggregations: z.array(aggregation).max(20).default([]),
    groupBy: z.array(fieldPath).max(10).default([]),
    orderBy: z.array(z.object({ field: fieldPath, direction: z.enum(['asc', 'desc']) }).strict()).max(5).default([]),
    // Bounded here as well as at execution: a manifest asking for ten million
    // rows should be rejected before anything is dispatched.
    limit: z.number().int().min(1).max(50_000).default(1000),
  })
  .strict();

export const joinSpec = z
  .object({
    conceptId: uuid,
    /** Which sources contribute, and the field each joins on. */
    participants: z
      .array(z.object({ connectionId: uuid, field: fieldPath }).strict())
      .min(2)
      .max(12),
  })
  .strict();

/**
 * The compiled manifest.
 *
 * THIS IS WHAT THE MODEL PRODUCES AND THE ENGINE EXECUTES. No free-text query, no
 * SQL, no expression language — a declarative structure the engine translates per
 * connector. That is what makes "no model runs in the query path" true rather
 * than aspirational.
 */
export const manifest = z
  .object({
    version: z.literal(1),
    question: z.string().min(1).max(2000),
    sources: z.array(sourceQuery).min(1).max(12),
    joins: z.array(joinSpec).max(12).default([]),
    /** Set when the answer is a single figure rather than rows. */
    scalar: z.string().max(64).optional(),
  })
  .strict();

export type Manifest = z.infer<typeof manifest>;
export type SourceQuery = z.infer<typeof sourceQuery>;
export type Filter = z.infer<typeof filter>;

/* ── API boundary ───────────────────────────────────────────────────────── */

export const email = z.string().email().max(320).transform((v) => v.toLowerCase().trim());

/**
 * A password.
 *
 * LENGTH, AND NOT A COMPOSITION RULE. Requiring a symbol and a digit produces
 * `Password1!` and pushes people toward patterns a cracker tries first. Length is
 * what actually costs an attacker, and the breach-list check at set time — not at
 * login — is what catches the rest.
 */
export const password = z.string().min(12).max(200);

export const loginRequest = z.object({ email, password: z.string().min(1).max(200) }).strict();

export const registerRequest = z
  .object({
    email,
    password,
    firstName: z.string().min(1).max(100).trim(),
    lastName: z.string().min(1).max(100).trim(),
    organisationName: z.string().min(1).max(200).trim(),
  })
  .strict();

export const paginationQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2000).optional(),
  })
  .strict();
