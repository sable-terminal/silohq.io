/*
 * 103 — the bottleneck that is contention rather than dependency.
 *
 * ── §2.1: "Resource edges are the hardest and most real" ───────────────────
 *
 * "Several downstream things compete for the same upstream capacity. Most
 * genuine bottlenecks are contention rather than dependency, and a graph
 * without them will find the wrong critical path. Deferred to phase two, but
 * the edge kind exists from the start so the graph does not need rebuilding."
 *
 * 097 admitted the kind and step three stopped at one. This gives it the one
 * thing that makes it different from a hard edge: how much the upstream thing
 * can serve, and therefore how long the queue behind it takes to clear.
 *
 * ── WHAT THIS BUILDS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
 *
 * It does NOT assign queue positions. Which of four hundred contending records
 * is served first is a fact about the customer's scheduling that nothing in
 * this graph carries, and a walk that ordered them would be publishing a
 * priority nobody stated — with the first record reported as fine and the last
 * as ruined on the strength of an arbitrary sort.
 *
 * What it reports instead is the contention itself: how many records draw on
 * this resource, and how long the whole queue takes to clear at the stated
 * capacity. That is the figure §2.1 is actually after. A resource that clears
 * ten a week with four hundred waiting IS the critical path, and a graph that
 * said only "these four hundred are affected in three days" would put it
 * nowhere.
 *
 * It also does not model recovery. A stated failure takes the capacity to
 * nothing; what happens to the backlog when the upstream returns is a question
 * about a second event, and this engine is given one.
 */

ALTER TABLE dependency_edges
  ADD COLUMN capacity_value numeric CHECK (capacity_value IS NULL OR capacity_value > 0),
  ADD COLUMN capacity_unit  text    CHECK (capacity_unit IN ('hours', 'days', 'weeks'));

/*
 * REQUIRED ON A RESOURCE EDGE, REFUSED ON THE OTHERS, and only once confirmed —
 * a proposal has no kind yet, exactly as with a soft edge's cost.
 *
 * A capacity of nought is refused rather than meaning "cannot serve at all":
 * that is a hard edge, and having two ways to say it is how half the graph ends
 * up saying it the other way.
 */
ALTER TABLE dependency_edges
  ADD CONSTRAINT dependency_edges_capacity_has_unit CHECK (
    (capacity_value IS NULL) = (capacity_unit IS NULL)
  );

ALTER TABLE dependency_edges
  ADD CONSTRAINT dependency_edges_resource_states_capacity CHECK (
    confirmed_at IS NULL OR (kind = 'resource') = (capacity_value IS NOT NULL)
  );

/*
 * §2.1 — what the contention actually costs, per record reached through a
 * resource edge.
 *
 * BOTH COLUMNS OR NEITHER. A clearance time with no count behind it is a figure
 * nobody can check, and a count with no clearance is a number with no meaning.
 */
ALTER TABLE simulation_results
  ADD COLUMN contending_records integer CHECK (contending_records IS NULL OR contending_records >= 1),
  ADD COLUMN clearance_hours    numeric CHECK (clearance_hours IS NULL OR clearance_hours >= 0);

ALTER TABLE simulation_results
  ADD CONSTRAINT simulation_results_contention_is_complete CHECK (
    (contending_records IS NULL) = (clearance_hours IS NULL)
  );
