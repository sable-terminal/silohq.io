import { z } from 'zod';
import { DEFAULT_LIMITS } from '../utils/bounds.util';

/**
 * A question, as it arrives over HTTP.
 *
 * BOUNDED AT THE DOOR AS WELL AS IN THE ENGINE. The engine's bounds exist to
 * stop a question that turned out to be enormous; these exist to stop one that
 * was obviously enormous before anything ran — a limit of a million or four
 * hundred filters is not a question anybody meant to ask.
 */

const comparison = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null']);

const filter = z
  .object({
    field: z.string().min(1).max(128),
    op: comparison,
    /*
     * ANY JSON SCALAR OR A LIST OF THEM. A filter value is compared, never
     * interpolated — the SQL transport parameterises it and the HTTP one URL
     * encodes it — so the shape is what matters here rather than the content.
     */
    value: z
      .union([
        z.string().max(4096),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string().max(512), z.number(), z.boolean()])).max(500),
      ])
      .optional(),
  })
  .strict()
  .refine((f) => f.op === 'is_null' || f.value !== undefined, {
    message: 'This comparison needs a value.',
    path: ['value'],
  });

export const ask = z
  .object({
    object: z.string().min(1).max(128),
    filters: z.array(filter).max(50).default([]),
    sort: z
      .array(
        z
          .object({
            field: z.string().min(1).max(128),
            direction: z.enum(['asc', 'desc']).default('asc'),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    /** Empty means every field the connector describes. */
    fields: z.array(z.string().min(1).max(128)).max(200).default([]),
    limit: z.number().int().min(1).max(DEFAULT_LIMITS.maxRows).default(100),

    /*
     * NAMING SOURCES IS OPTIONAL AND CHANGES THE MEANING OF A FAILURE. Left out,
     * the question goes to every connection the caller can reach. Named, a
     * source they cannot reach is a denial rather than a silent omission — the
     * difference between "everything I could see" and "the four I asked for".
     */
    connectionIds: z.array(z.string().uuid()).max(20).optional(),

    /*
     * WHETHER A PARTIAL ANSWER IS ACCEPTABLE, STATED BY THE CALLER. The default
     * is no: a total computed from five of six systems is not a smaller total,
     * it is a wrong one, and it looks exactly like a right one. A caller that
     * genuinely wants to show which sources are down asks for it explicitly.
     */
    allowPartial: z.boolean().default(false),
  })
  .strict();
