import { z } from 'zod';

/**
 * §12 — a word, and the concept it is laid over.
 *
 * SHORT ON PURPOSE. A terminology skin replaces a concept's name in a sidebar
 * and a sentence; 64 characters is already longer than anything that reads as
 * a name, and a paragraph here would break every layout that shows one.
 */

export const conceptId = z.object({ conceptId: z.string().uuid() }).strict();

export const setTerm = z
  .object({ conceptId: z.string().uuid(), term: z.string().trim().min(1).max(64) })
  .strict();
