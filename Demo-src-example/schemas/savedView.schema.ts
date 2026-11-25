import { z } from 'zod';
import { askConcept } from './concept.schema';

/**
 * §7 — saving a question.
 *
 * THE QUESTION IS `askConcept` WITHOUT THE JOIN, and reusing it rather than
 * restating it is deliberate: a saved view has to accept exactly what the
 * engine accepts, and two hand-kept copies of that shape drift the moment one
 * of them gains a filter operator.
 *
 * THE JOIN IS OMITTED BECAUSE A JOINED ANSWER IS TWO CONCEPTS, and this table
 * stores one `concept_id`. Saving one would mean keeping half its definition in
 * a column and half in jsonb, which is the kind of split that survives review
 * and then loses the other half in a migration.
 */
export const savedQuery = askConcept.omit({ join: true });

export const createSavedView = z
  .object({
    name: z.string().trim().min(1).max(128),
    conceptId: z.string().uuid(),
    query: savedQuery,
  })
  .strict();

export const savedViewId = z.object({ id: z.string().uuid() }).strict();

export const renameSavedView = z.object({ name: z.string().trim().min(1).max(128) }).strict();

/* ── AUTH rev 7: sharing ─────────────────────────────────────────────────── */

/**
 * One grantee, never two.
 *
 * THE UNION IS THE CONSTRAINT, as it is in the table: a share that named both a
 * person and a scope would have to decide which one it meant at read time, and
 * whichever it picked would surprise whoever wrote it.
 */
export const shareView = z
  .object({
    grantee: z.union([
      z.object({ membershipId: z.string().uuid() }).strict(),
      z.object({ scopeId: z.string().uuid() }).strict(),
      z.object({ organisationWide: z.literal(true) }).strict(),
    ]),
    access: z.enum(['view', 'run', 'copy']),
    /* A share that ends by itself is the one nobody has to remember to take back. */
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const shareId = z.object({ id: z.string().uuid(), shareId: z.string().uuid() }).strict();

/* ── AUTH rev 7: transfer on membership removal ──────────────────────────── */

export const transferFlagId = z.object({ flagId: z.string().uuid() }).strict();

/**
 * rev 7's three answers, and no fourth.
 *
 * THERE IS NO `unreviewed`. A decision is what leaves the queue, so "not
 * decided" is the absence of this field rather than a value it can take —
 * which is also what the table's CHECK says.
 */
export const reviewTransfer = z
  .object({ decision: z.enum(['shared', 'retained', 'archived']) })
  .strict();

export const transferCron = z
  .object({ flagId: z.string().uuid(), automationId: z.string().uuid() })
  .strict();
