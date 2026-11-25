/*
 * 101 — what actually happened, counted.
 *
 * ── §2.2: "Proposed from history" ──────────────────────────────────────────
 *
 * "Where a Silo holds enough, observed lead times are derived from what
 * actually happened: the elapsed time between the upstream event and the
 * downstream one, with the distribution and the sample size. This is far better
 * than an estimate and it is only available where history exists."
 *
 * ── §8: "Counts and statistics, never values" ──────────────────────────────
 *
 * That clause is the whole design of this table. `transitions` is the one place
 * in the architecture that holds customer values, and the storage disclosure is
 * about exactly those two columns. Deriving a lead time reads WHEN things
 * happened and never WHAT they said, so nothing here is a value, an entity or a
 * field path — it is a count and six numbers in hours.
 *
 * ── AND IT IS EVIDENCE, NOT A DECISION ────────────────────────────────────
 *
 * An observation attaches to a confirmed edge as readily as to a proposal.
 * §2.3's "the decision holds until changed" is about the lead time somebody
 * confirmed, and a row here changes none of it: it lets the product say "you
 * said three days, four hundred instances say five" without the graph moving
 * underneath anybody. §4.1 then needs these on confirmed edges, because a
 * probabilistic run is "only available where history exists".
 */

CREATE TABLE edge_observations (
  edge_id         uuid        PRIMARY KEY REFERENCES dependency_edges(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * §4.3 — "Sample size for every edge on the path, always shown. A probability
   * derived from an edge with eleven observations is presented with that number
   * next to it." So it is NOT NULL and it travels with everything else here.
   */
  sample_count    integer     NOT NULL CHECK (sample_count >= 1),

  /*
   * §8 — "distribution parameters". Hours, matching every other duration the
   * walk adds up, and enough of them that §4.3's "median delay, and the spread"
   * needs no second pass over data that will have been swept by then.
   *
   * THE MEDIAN IS WHAT GETS PROPOSED, not the mean. One order that sat for two
   * hundred days drags a mean into a figure that describes nothing, and a
   * proposal is supposed to be the thing a person can sanity-check at a glance.
   */
  mean_hours      numeric     NOT NULL CHECK (mean_hours >= 0),
  median_hours    numeric     NOT NULL CHECK (median_hours >= 0),
  p90_hours       numeric     NOT NULL CHECK (p90_hours >= 0),
  min_hours       numeric     NOT NULL CHECK (min_hours >= 0),
  max_hours       numeric     NOT NULL CHECK (max_hours >= 0),
  /* §4.3's "spread". Nought is legitimate: every instance took the same time. */
  stddev_hours    numeric     NOT NULL CHECK (stddev_hours >= 0),

  /* §8 — "observed from, observed to". The window the sample was drawn over,
     because a distribution from last March is a different claim from one from
     the last four weeks, and a Silo's retention window moves both ends. */
  observed_from   timestamptz NOT NULL,
  observed_to     timestamptz NOT NULL,

  computed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT edge_observations_window CHECK (observed_to >= observed_from),
  CONSTRAINT edge_observations_ordered CHECK (min_hours <= median_hours AND median_hours <= max_hours)
);

ALTER TABLE edge_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_observations FORCE  ROW LEVEL SECURITY;
CREATE POLICY edge_observations_tenant ON edge_observations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/*
 * UPDATE IS ALLOWED HERE AND NOWHERE ELSE IN THIS SUBSYSTEM. A revision to an
 * edge is a decision and is kept forever; a recomputed distribution is the same
 * measurement taken again over a window that has moved, and keeping every one
 * would be a table that grows with the sweep rather than with the operation.
 * `computed_at` says how stale the current one is, which is the only thing a
 * reader needs from the ones before it.
 */
GRANT SELECT, INSERT, UPDATE ON edge_observations TO silo_app;
