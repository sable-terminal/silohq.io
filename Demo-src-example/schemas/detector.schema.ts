import { z } from 'zod';

const fieldPath = z.string().min(1).max(256);

export const runDetectors = z
  .object({
    conceptId: z.string().uuid(),
    measure: z
      .object({
        name: z.string().min(1).max(256),
        /*
         * WHERE TO READ IT, PER CONNECTION. The concept says which objects are
         * the same thing and how they match; it does not say which column holds
         * the figure being compared, because that is a property of the question
         * rather than of the concept.
         */
        byConnection: z.record(z.string().uuid(), fieldPath),
      })
      .strict(),
    limit: z.number().int().min(1).max(5000).optional(),

    /*
     * WHAT THE OTHER FOUR DETECTORS SHOULD EXAMINE.
     *
     * OPTIONAL, BECAUSE A DETECTOR NOBODY CONFIGURED IS NOT AN ERROR. It is a
     * detector with nothing to look at, and the response says so by name rather
     * than returning a shorter list — the same reason §3.1's unavailable three
     * are listed rather than omitted.
     *
     * NOTHING HERE IS A DEFAULT. §1: no domain knowledge ships, so nothing in
     * this product may decide that dispatch follows payment or that `supplier`
     * is the column worth grouping on. Absent means absent.
     */
    examine: z
      .object({
        absence: z
          .object({ fields: z.array(fieldPath).min(2).max(64) })
          .strict()
          .optional(),
        referentialBreak: z
          .object({
            referenceField: fieldPath,
            targetObject: z.string().min(1).max(128),
            targetKeyField: fieldPath,
          })
          .strict()
          .optional(),
        sequence: z
          .object({
            /* Two is the fewest that can be out of order. */
            stepFields: z.array(fieldPath).min(2).max(32),
          })
          .strict()
          .optional(),
        concentration: z
          .object({ groupField: fieldPath, weightField: fieldPath.optional() })
          .strict()
          .optional(),

        /*
         * ── The three that read a range ──────────────────────────────────
         *
         * DECLARED LIKE EVERY OTHER DETECTOR, AND NOT GATED ON STORAGE. They
         * need historical data, not a Silo — and the source system usually
         * already holds it, which is why an order table with created and
         * completed timestamps answers timing deviation with nothing stored
         * anywhere. Where the history can be read from is resolved per run
         * against what the connections declare.
         *
         * WHAT STAYS THE CUSTOMER'S TO SAY IS WHICH FIELDS CARRY THE DATES.
         * Nothing here knows that `completed_at` ends what `created_at` began,
         * or that `supplier` is the thing whose failures recur — that is domain
         * knowledge, and §1 says none ships.
         */
        timing: z
          .object({
            startField: fieldPath,
            endField: fieldPath,
            /*
             * OPTIONAL, AND IT CHANGES THE ANSWER MORE THAN ANYTHING ELSE HERE.
             * Express orders take a day and standard ones take four; without a
             * class every express order over two days looks fine and every
             * standard one under three looks fast.
             */
            classField: fieldPath.optional(),
          })
          .strict()
          .optional(),

        drift: z
          .object({
            dateField: fieldPath,
            /*
             * A RATE NEEDS A DENOMINATOR OR IT IS A VOLUME. With this, the rate
             * is the share of each period's records where the field is set.
             * Without it the measure is volume and the finding says so, because
             * a count per period moves for business reasons that are nobody's
             * exception.
             */
            subjectField: fieldPath.optional(),
            label: z.string().min(1).max(128).optional(),
          })
          .strict()
          .optional(),

        recurrence: z
          .object({ sourceField: fieldPath, dateField: fieldPath })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const decideFinding = z
  .object({
    disposition: z.enum(['confirmed', 'dismissed', 'not_relevant']),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
  /*
   * §9 — `finding_dismissed` carries the reason, and the schema is where that
   * is unskippable. It is both the signal that teaches ranking and the evidence
   * that a person looked, which is what matters if the finding later turns out
   * to have been important.
   */
  .refine((v) => v.disposition !== 'dismissed' || Boolean(v.reason?.trim()), {
    message: 'Say why it is not worth looking at.',
    path: ['reason'],
  });

/**
 * Listing findings.
 *
 * A QUERY STRING NEEDS A SCHEMA LIKE A BODY DOES, and this one was missing —
 * so `query()` returned undefined, the controller destructured it, and every
 * GET /findings was a 500. The accessor cannot distinguish "validated to
 * nothing" from "never validated", which is why the route has to say.
 *
 * A STRING, NOT A BOOLEAN, because that is what a query string carries. Coercing
 * here means the controller stops comparing against the literal 'true' and the
 * next person cannot get that comparison subtly wrong.
 */
export const listFindings = z
  .object({
    includeDecided: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
