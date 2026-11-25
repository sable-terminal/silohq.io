import { z } from 'zod';

/**
 * §5 at the door.
 *
 * WHAT IS ABSENT HERE IS THE POINT. There is no field for a figure, a threshold,
 * a weight, or an instruction to the model — the request says which concepts and
 * what the person was looking into, and everything else the model receives is
 * built by `engine/ranking.summarise` from findings that already exist.
 *
 * NO PROMPT PASSES THROUGH. `question` is the person's own words about what they
 * are investigating, and it reaches the model as a user turn rather than as an
 * instruction. There is deliberately no way to send a system instruction from
 * outside this process: the validator downstream is what makes the output safe,
 * and a caller-supplied instruction would be an invitation to try to talk past
 * it.
 */
export const rankFindings = z
  .object({
    conceptIds: z.array(z.string().uuid()).min(1).max(32).optional(),
    question: z.string().min(1).max(1000).optional(),
    /* Ties the ranking to whatever the caller is calling this investigation. */
    investigationRef: z.string().min(1).max(128).optional(),
  })
  .strict();
