import { z } from 'zod';

/**
 * Simulation §5 — the scenario, which is the whole of what a caller supplies.
 *
 * THE BOUNDS ARE THE CALLER'S AND THE CEILING IS NOT. §3.1 bounds traversal per
 * hop; a caller may ask for less than the ceiling and never more, because the
 * ceiling is what keeps one person's scenario from being an outage on somebody
 * else's production systems.
 */
export const saveScenario = z
  .object({
    name: z.string().trim().min(1).max(128),
    failedConceptId: z.string().uuid(),
    /* §3.1 — "a stated failure on an entity", by the identifier its own system
       states. A hundred is the schema's own ceiling. */
    failedEntityRefs: z.array(z.string().trim().min(1).max(512)).min(1).max(100),
    maxHops: z.number().int().min(1).max(10).optional(),
    maxPerHop: z.number().int().min(1).max(1000).optional(),

    /*
     * §4 — probabilistic mode, and the two things it cannot run without.
     *
     * A HORIZON, because a run samples lead times and not the graph: every
     * record reached is reached in every iteration, so §4.3's "probability of
     * being affected" is only a figure against a window to be affected within.
     *
     * AN ITERATION COUNT, because §4.2 says it is "bounded and stated": "a
     * figure from a hundred runs and one from ten thousand are different
     * claims". The floor of a hundred is where the claim starts being one.
     */
    mode: z.enum(['deterministic', 'probabilistic']).optional(),
    horizonHours: z.number().finite().positive().max(100_000).optional(),
    iterations: z.number().int().min(100).max(10_000).optional(),
  })
  .strict();

export const scenarioId = z.object({ id: z.string().uuid() }).strict();
export const runId = z.object({ id: z.string().uuid() }).strict();

export const shareScenario = z.object({ membershipId: z.string().uuid() }).strict();

export const scenarioShare = z
  .object({ id: z.string().uuid(), membershipId: z.string().uuid() })
  .strict();

/*
 * §5 — "Comparison of two runs shows what changed."
 *
 * THE EARLIER RUN IS NAMED IN THE PATH AND THE LATER IN THE QUERY, so the
 * direction is in the URL rather than in a convention about argument order.
 * "Entered" and "left" mean the opposite thing if the two are swapped.
 */
export const compareRuns = z.object({ against: z.string().uuid() }).strict();
