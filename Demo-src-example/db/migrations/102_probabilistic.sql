/*
 * 102 — sampling instead of asserting.
 *
 * ── §4.1: "Observed history only" ──────────────────────────────────────────
 *
 * "An edge with four hundred recorded instances has a distribution. An edge
 * with a lead time somebody typed has a single number and no distribution at
 * all... Inventing a distribution from an estimate is the specific dishonesty
 * that makes probabilistic simulation worthless, and it is easy to do
 * accidentally."
 *
 * ── QUANTILES, BECAUSE A MEAN AND A DEVIATION ARE A SHAPE NOBODY OBSERVED ──
 *
 * 101 stored the summary §8 asks for: a mean, a median, a spread. Sampling from
 * those requires assuming a shape, and the obvious assumption — normal — is
 * wrong in a way that matters: lead times are bounded below at nought and have
 * a long right tail, so a normal fitted to them produces negative lead times at
 * the bottom and understates the top. Choosing lognormal instead is a better
 * guess and still a guess.
 *
 * Deciles avoid the question. Sampling by interpolating between observed
 * quantiles is non-parametric: it cannot produce a lead time shorter than the
 * shortest ever seen or longer than the longest, and it keeps whatever skew the
 * operation actually has. That is still "distribution parameters" in §8's
 * sense, and it is the version that does not smuggle in an assumption.
 *
 * ELEVEN VALUES: the minimum, nine deciles, the maximum.
 */

ALTER TABLE edge_observations
  ADD COLUMN quantiles numeric[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(quantiles) IN (0, 11));

/*
 * ── §4.3 NEEDS SOMETHING THAT CAN VARY, AND THE SPEC DOES NOT NAME IT ─────
 *
 * "For each affected entity: probability of being affected, median delay, and
 * the spread."
 *
 * A probabilistic run samples lead times; it does not sample the graph, which
 * §2.3 says is a set of confirmed assertions. So every record the walk reaches
 * is reached in every iteration, and "probability of being affected" would be
 * 1.0 for every row — a number that looks like information and is not.
 *
 * It becomes a real figure against a horizon: how likely the failure is to
 * reach this record WITHIN a stated window. §4.2's "the proportion of runs in
 * which it was affected" is then literally what it computes, and §4.3's three
 * numbers are three different things rather than one repeated.
 *
 * SO A HORIZON IS AN INFERENCE, NOT A QUOTATION, and it is written down here
 * rather than left in somebody's head. It is required for a probabilistic
 * scenario and refused for a deterministic one: §3.1 returns everything reached
 * with its accumulated delay and makes no claim that needs a window.
 */
ALTER TABLE scenarios
  ADD COLUMN horizon_hours numeric CHECK (horizon_hours IS NULL OR horizon_hours > 0);

/*
 * §4.2 — "Iteration count is bounded and stated. The result carries how many
 * runs it came from, because a figure from a hundred runs and one from ten
 * thousand are different claims."
 */
ALTER TABLE scenarios
  ADD COLUMN iterations integer CHECK (iterations IS NULL OR iterations BETWEEN 100 AND 10000);

ALTER TABLE scenarios
  ADD CONSTRAINT scenarios_probabilistic_is_complete CHECK (
    (mode = 'probabilistic') = (horizon_hours IS NOT NULL AND iterations IS NOT NULL)
  );

/*
 * §4.3 — "median delay, and the spread".
 *
 * `delay_hours` CARRIES THE MEDIAN IN THIS MODE, not a second column. It is the
 * one figure both modes have: deterministic computes it once, probabilistic
 * takes the middle of many. A separate `median_delay_hours` would leave every
 * reader choosing which of two columns to trust.
 */
ALTER TABLE simulation_results
  ADD COLUMN delay_p10_hours numeric CHECK (delay_p10_hours IS NULL OR delay_p10_hours >= 0),
  ADD COLUMN delay_p90_hours numeric CHECK (delay_p90_hours IS NULL OR delay_p90_hours >= 0);

/*
 * §4.1 — "Where any edge on a path lacks observations, that path is computed
 * deterministically and the result says so PER PATH, NOT PER SIMULATION."
 *
 * That emphasis is the column. A flag on the run would say "some of this is
 * estimated" and leave a reader unable to tell which rows, which is worse than
 * not saying it: they would discount the ones that were measured and trust the
 * ones that were not, in whatever proportion their optimism suggested.
 */
ALTER TABLE simulation_results
  ADD COLUMN estimated boolean NOT NULL DEFAULT true;

/*
 * A probability belongs to a probabilistic row and to no other. §4.3's numbers
 * arrive together or not at all, so a row cannot carry a probability without a
 * spread or the other way round.
 */
ALTER TABLE simulation_results
  ADD CONSTRAINT simulation_results_probability_is_complete CHECK (
    (probability IS NULL) = (delay_p10_hours IS NULL)
      AND (delay_p10_hours IS NULL) = (delay_p90_hours IS NULL)
  );
