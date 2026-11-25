/*
 * 100 — the edges where the downstream thing carries on.
 *
 * ── §3.2: "A soft edge propagates the delay and the stated cost" ───────────
 *
 * "A hard edge propagates the failure. A soft edge propagates the delay and the
 * stated cost, and the downstream thing continues. A path through a soft edge
 * is reported separately from one through only hard edges. Those are different
 * severities and merging them makes everything look equally broken."
 *
 * 097 already admits `kind = 'soft'`, and step three stopped at one rather than
 * guessing which of the two things it meant. What was missing is the cost: §2.1
 * lists a lead time and a buffer on an edge and nothing about what proceeding
 * degraded actually costs, so there was nowhere to put the thing §3.2 says a
 * soft edge propagates.
 *
 * ── WHY IT IS TEXT AND NOT A NUMBER ───────────────────────────────────────
 *
 * §3.2 calls it "the stated cost" — something a person says when they confirm
 * the edge, in the terms their operation uses: overtime, a penalty clause, air
 * freight instead of sea. A number would need a unit and a currency nobody
 * agreed, and the moment it had one something would add it up across a path and
 * produce a headline figure. §4.3 refuses exactly that move for probabilities —
 * "Aggregating across paths with different evidence quality produces a number
 * that looks authoritative and is not" — and the same reasoning holds here.
 *
 * So the costs on a path travel as a list, in the words somebody wrote, and
 * nothing sums them.
 *
 * ── REQUIRED ON A SOFT EDGE, REFUSED ON THE OTHERS ────────────────────────
 *
 * A soft edge with no stated cost says the downstream thing continues and
 * declines to say at what price, which is the half of §3.2 that makes soft
 * different from no edge at all. A hard edge has no such thing to state: the
 * downstream thing does not happen.
 */

ALTER TABLE dependency_edges
  ADD COLUMN degraded_cost text
    CHECK (degraded_cost IS NULL OR length(trim(degraded_cost)) BETWEEN 1 AND 500);

/*
 * Only on a CONFIRMED edge, because a proposal has no kind yet. 097's
 * `dependency_edges_confirmed_is_complete` already says a confirmed edge
 * carries its kind and lead time; this adds the one field that depends on
 * which kind it turned out to be.
 */
ALTER TABLE dependency_edges
  ADD CONSTRAINT dependency_edges_soft_states_its_cost CHECK (
    confirmed_at IS NULL OR (kind = 'soft') = (degraded_cost IS NOT NULL)
  );

/*
 * §3.2 — "Those are different severities and merging them makes everything look
 * equally broken."
 *
 * ── THE DEFAULT IS THE ONE THAT WAS ALREADY TRUE ──────────────────────────
 *
 * Every row written before this migration came from step three, which walked
 * hard edges only. So `failed` is not a guess about existing data: it is what
 * those rows already meant, and saying it explicitly is what lets the column be
 * NOT NULL without a backfill that invents anything.
 */
ALTER TABLE simulation_results
  ADD COLUMN severity text NOT NULL DEFAULT 'failed'
    CHECK (severity IN ('failed', 'degraded'));

/*
 * §3.2 — the stated costs of every soft edge on this path, in order, in the
 * words somebody wrote. Empty on a path through only hard edges.
 *
 * NOT SUMMED, NOT SUMMARISED. A list of what it costs is a thing a reader can
 * check; a total would be a figure nobody agreed the units of.
 */
ALTER TABLE simulation_results
  ADD COLUMN degraded_costs text[] NOT NULL DEFAULT '{}';

ALTER TABLE simulation_results
  ADD CONSTRAINT simulation_results_degraded_has_a_cost CHECK (
    (severity = 'degraded') = (cardinality(degraded_costs) > 0)
  );

/* Reading one severity without reading the other. */
CREATE INDEX simulation_results_by_severity ON simulation_results (run_id, severity);
