import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

/**
 * §2.8 — declaring which system decides a field.
 *
 * `fieldPath` IS THE CONCEPT'S NAME FOR THE FIELD, not any system's. One
 * statement has to cover every system the concept spans — including ones
 * connected later, which cannot be named here because they do not exist yet.
 */
export const declareAuthority = z
  .object({
    conceptId: uuid,
    fieldPath: z.string().min(1).max(256).trim(),
    connectionId: uuid,
    /*
     * WHY, IN THEIR WORDS, AND OPTIONAL. A reason nobody wrote is better than a
     * required box somebody fills with a full stop — but this decides what
     * every later figure says, and the person reading it in a year will want it.
     */
    because: z.string().min(1).max(512).trim().optional(),
  })
  .strict();

export const listAuthorities = z
  .object({ conceptId: uuid.optional() })
  .strict();

/**
 * §2.3 — correcting what a system calls a column.
 *
 * PER CONNECTION AND PER OBJECT, because that is the grain a correction is true
 * at: `amt_gross` on this ERP's invoices means `total`, and the same word on
 * some other table of the same system may not.
 */
export const correctField = z
  .object({
    connectionId: uuid,
    objectName: z.string().min(1).max(128).trim(),
    /** What the source calls it. */
    sourceField: z.string().min(1).max(256).trim(),
    /** What this organisation calls it. */
    canonicalField: z.string().min(1).max(256).trim(),
  })
  .strict();

export const listCorrections = z.object({ connectionId: uuid }).strict();

/**
 * §7.3 — naming a field a time, and saying what kind.
 *
 * A CLOSED SET OF KINDS. A question about when something HAPPENED is a
 * different question from when a record was TOUCHED, and a compiler choosing
 * between them needs the difference to be a fixed vocabulary rather than
 * whatever somebody typed.
 */
export const declareTimeField = z
  .object({
    conceptId: uuid,
    fieldPath: z.string().min(1).max(256).trim(),
    kind: z.enum(['occurred', 'created', 'modified', 'effective']),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const timeFieldParams = z.object({ conceptId: uuid }).strict();
