import { z } from 'zod';

/**
 * Import §4 and §8 — what the model must return when it reads a document.
 *
 * VALIDATED ON THE WAY OUT OF THE MODEL, AND REJECTED RATHER THAN REPAIRED.
 * An answer of the wrong shape is not coaxed into the right one: a value
 * somebody's parser rescued from malformed output is a value nobody can say the
 * model gave.
 *
 * EVERY VALUE COMES WITH THE PASSAGE IT WAS READ FROM. The quote is what the
 * engine looks for in the document, and a value whose quote is not there is
 * refused — which is what stops a model's invention reaching the row store.
 */
export const proseAnswer = z
  .object({
    fields: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
      z
        .object({
          value: z.string().max(4096).nullable(),
          quote: z.string().max(2000).nullable(),
          /* The model's own score, and presented as that. */
          confidence: z.number().min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict();

export type ProseAnswer = z.infer<typeof proseAnswer>;
