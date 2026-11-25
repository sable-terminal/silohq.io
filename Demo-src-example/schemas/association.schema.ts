import { z } from 'zod';

/*
 * §4 at the door.
 *
 * NOTHING HERE ACCEPTS A VALUE READ OUT OF A CUSTOMER'S DATA, and nothing here
 * accepts a causal claim. The first is §3.2's line; the second is §4.2's, and
 * both are held in the same place for the same reason — a rule that lives only
 * in a service is a rule the next caller routes around.
 */

const fieldPath = z.string().min(1).max(256);

export const computeAssociations = z
  .object({
    /*
     * NARROWING IS OPTIONAL AND DELIBERATELY NOT A FILTER ON THE OUTPUT. Given
     * concepts, the computation runs over their findings and replaces their
     * associations; given none, it runs over everything. Computing across all
     * of them and then hiding rows would report a lift measured against a
     * population the reader cannot see.
     */
    conceptIds: z.array(z.string().uuid()).min(1).max(32).optional(),
  })
  .strict();

export const designateOutcome = z
  .object({
    conceptId: z.string().uuid(),

    /*
     * WHICH FIELD, NEVER WHAT LATE MEANS. §4.3 — a threshold typed in here
     * would be a domain assumption, and §1 says none ship. How late counts as
     * late is what the detectors compute against the population.
     */
    fieldPath,

    /*
     * NO DEFAULT, ON PURPOSE. Days late is higher-is-worse and margin is
     * lower-is-worse, and there is no way to tell which a field is without
     * being told. A default would be right about half the time and silently
     * invert every ranking the other half.
     */
    direction: z.enum(['higher_is_worse', 'lower_is_worse']),

    /** What the people who work here call it. */
    label: z.string().min(1).max(128).optional(),
  })
  .strict();
