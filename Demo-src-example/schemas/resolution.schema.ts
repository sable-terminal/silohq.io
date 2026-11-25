import { z } from 'zod';

/**
 * §2.6 at the door.
 *
 * A REFERENCE, NEVER A RECORD. Everything this schema accepts is how a source
 * identifies a row — the same thing `findings.entity_ref` carries and screens
 * already display. There is no shape here that could carry what a record says,
 * which matters more on this endpoint than most because what arrives here is
 * forwarded to a model.
 */

const reference = z.string().min(1).max(512);

export const proposeMatch = z
  .object({
    /*
     * THE OTHER SIDE'S OWN UNMATCHED REFERENCES, and the bound is the point: the
     * model chooses among rows that already failed to match, rather than
     * searching an estate. A reference that matched something else is not a
     * candidate, because it is already resolved.
     */
    candidates: z.array(reference).min(1).max(50),
  })
  .strict();

/**
 * Narrowing the queue to one concept.
 *
 * OPTIONAL, AND THE SCHEMA IS NOT. Without it `query()` returns undefined and
 * the controller's destructure throws — a 500 on a route that takes no
 * arguments at all, which is the least expected place to find one.
 */
export const openQuestions = z
  .object({ conceptId: z.string().uuid().optional() })
  .strict();
