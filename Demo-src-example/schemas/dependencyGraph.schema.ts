import { z } from 'zod';

/**
 * Simulation §2.1 — what a person supplies when they decide an edge.
 *
 * THE LEAD TIME IS REQUIRED AND THE BUFFER IS NOT, which mirrors the schema's
 * own CHECK. §3.1 accumulates delay along a path, so an edge confirmed with no
 * lead time would be walked as nought and would silently shorten every result
 * it appeared in — a wrong answer that looks computed, which is the exact
 * failure §7 says `graph.confirm` exists to guard against.
 *
 * NO UPPER BOUND ON A LEAD TIME BEYOND THE ABSURD. A six-month lead time on a
 * capital order is real, and a validator that refused it would push somebody
 * into entering it in the wrong unit.
 */
const duration = z.number().finite().min(0).max(100_000);

export const edgeKind = z.enum(['hard', 'soft', 'resource']);
export const timeUnit = z.enum(['hours', 'days', 'weeks']);

/*
 * §3.2 — "A soft edge propagates the delay and the stated cost, and the
 * downstream thing continues."
 *
 * REFUSED HERE WHEN IT DOES NOT BELONG, rather than only in the service. A soft
 * edge that arrives without a cost, or a hard edge that arrives with one, is a
 * caller who has misunderstood which kind they are describing, and the earlier
 * they are told the less of their form they have to redo.
 */
const judgement = z.object({
  kind: edgeKind,
  leadTimeValue: duration,
  leadTimeUnit: timeUnit,
  bufferValue: duration.nullable().default(null),
  bufferUnit: timeUnit.nullable().default(null),
  degradedCost: z.string().trim().min(1).max(500).nullable().default(null),
  /* §2.1 — how much the upstream thing serves per unit of time. */
  capacityValue: z.number().finite().positive().max(1_000_000).nullable().default(null),
  capacityUnit: timeUnit.nullable().default(null),
});

/*
 * THE SHAPE IS EXTENDED AND THE RULE IS RESTATED, because `.extend` builds a
 * new object from the shape and does not carry a refinement across. Three
 * schemas that each say the rule is worse to read and better to trust than one
 * that says it for the caller who happens to hit the unextended path.
 */
const eachKindStatesItsOwn = (input: {
  kind: 'hard' | 'soft' | 'resource';
  degradedCost: string | null;
  capacityValue: number | null;
  capacityUnit: 'hours' | 'days' | 'weeks' | null;
}) =>
  (input.kind === 'soft') === (input.degradedCost !== null) &&
  (input.kind === 'resource') === (input.capacityValue !== null) &&
  (input.capacityValue === null) === (input.capacityUnit === null);

const kindRule = {
  message:
    'A soft edge states what proceeding degraded costs and a resource edge states its ' +
    'capacity, each with a unit. No other kind states either.',
  path: ['kind'],
};

export const edgeJudgement = judgement.strict().refine(eachKindStatesItsOwn, kindRule);

export const edgeId = z.object({ id: z.string().uuid() }).strict();

export const stateEdge = judgement
  .extend({
    fromConceptId: z.string().uuid(),
    toConceptId: z.string().uuid(),
  })
  .strict()
  .refine(eachKindStatesItsOwn, kindRule);

/*
 * §2.3 — a reason, because a revision replaces somebody's judgement. Trimmed
 * and non-empty so a space cannot satisfy it.
 */
const reason = z.string().trim().min(1).max(1000);

export const reviseEdge = judgement.extend({ reason }).strict().refine(eachKindStatesItsOwn, kindRule);

export const retireEdge = z.object({ reason }).strict();
