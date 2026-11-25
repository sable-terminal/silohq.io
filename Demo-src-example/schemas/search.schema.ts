import { z } from 'zod';

/**
 * What the search box may ask for.
 *
 * BOUNDED BEFORE IT REACHES A `LIKE` PATTERN. An unbounded needle is an
 * unbounded comparison run once per row per kind, which is a cheap way to make
 * a database do expensive work from a text field anybody can type into. A
 * hundred and twenty characters is longer than any name in the product.
 *
 * TRIMMED HERE SO THE SERVICE NEVER SEES THE SPACES. A query of one space is
 * not a search for anything, and matching it would return the whole tenant.
 */
export const search = z
  .object({ q: z.string().trim().min(1).max(120) })
  .strict();
