/*
 * §5 — how much a finding is worth looking at, and how long it has been true.
 *
 * ── Why the score is stored rather than computed on read ───────────────────
 *
 * It is computed from the RUN a finding came out of: the spread of its own
 * detector's other findings, which detectors agreed about the same entity, and
 * where the paths from those findings arrived. None of that survives the run.
 * Recomputing at read time would score a finding against whatever happens to be
 * in the table on the day somebody looks, which would silently change the
 * ordering of findings nobody re-ran.
 *
 * ── And why the components are stored beside it ────────────────────────────
 *
 * A score of 0.74 is not an explanation. Somebody asking why one finding sits
 * above another gets the six numbers and the weights, which is the same rule
 * §5.2 applies to ranking: a placement with no reasoning is an assertion.
 *
 * NO CUSTOMER DATA. Every component is a statistic about a finding's
 * surroundings — a magnitude, a count, a proportion, a hop distance. The line
 * 032 drew holds: `observed` and `expected` are the only figures read from a
 * record, and nothing here is one.
 */

ALTER TABLE findings
  /*
   * WHEN THIS FINDING WAS FIRST TRUE, as opposed to when it was last confirmed.
   * `detected_at` is overwritten on every upsert — the same fact found again is
   * the same row — so the table could say a six-month-old problem was found
   * this morning, and every question about how long something has been wrong
   * was unanswerable.
   */
  ADD COLUMN first_detected_at timestamptz NOT NULL DEFAULT now(),

  /*
   * HOW MANY RUNS HAVE RAISED IT. Counted, not inferred from timestamps, which
   * would need a record of the runs themselves.
   *
   * IT COUNTS RAISES AND NOT A CONSECUTIVE STREAK, and the difference is real:
   * a finding that went away for a month and came back is a different story
   * from one that never left. Telling those apart needs a record of the runs
   * where it was ABSENT, and nothing writes one — so this is the honest fact
   * available rather than the one that would be nicer to have.
   */
  ADD COLUMN raised_count integer NOT NULL DEFAULT 1 CHECK (raised_count >= 1),

  /* 0 to 1, four places — the precision `engine/scoring` rounds to, so a score
     read back is the score that was computed. */
  ADD COLUMN score numeric(5,4) CHECK (score IS NULL OR score BETWEEN 0 AND 1),

  /*
   * The components it was computed from. NULL where nothing has been scored;
   * a component absent FROM the object is one nobody could record, which is
   * deliberately different from one recorded as zero.
   */
  ADD COLUMN score_components jsonb;

/*
 * ── What may be in that object, named one key at a time ───────────────────
 *
 * THE SAME ARGUMENT 046 MAKES: naming the paths rather than walking the
 * document keeps the constraint cheap and keeps it readable, so a reviewer can
 * see exactly what is permitted.
 *
 * EVERY COMPONENT IS A PROPORTION. `engine/scoring` clamps all six to 0..1, and
 * this is what stops a later caller writing a raw z-score or a row count into
 * the same column and producing an ordering nobody can read.
 *
 * AND THE SET IS CLOSED, the way the detector list is closed in 032. A seventh
 * component is a change to what a score MEANS — every stored score was computed
 * without it — so it takes a migration rather than arriving silently in a
 * jsonb column beside the six that were weighted.
 *
 * A KEY THAT IS ABSENT IS ONE NOBODY COULD RECORD, which is deliberately
 * different from one recorded as zero, and is why each is nullable on its own.
 */
ALTER TABLE findings ADD CONSTRAINT findings_score_components_bounded CHECK (
  score_components IS NULL
  OR (
    jsonb_typeof(score_components) = 'object'
    AND (score_components -> 'deviationMagnitude' IS NULL
         OR (jsonb_typeof(score_components -> 'deviationMagnitude') = 'number'
             AND (score_components ->> 'deviationMagnitude')::numeric BETWEEN 0 AND 1))
    AND (score_components -> 'populationSize' IS NULL
         OR (jsonb_typeof(score_components -> 'populationSize') = 'number'
             AND (score_components ->> 'populationSize')::numeric BETWEEN 0 AND 1))
    AND (score_components -> 'corroboration' IS NULL
         OR (jsonb_typeof(score_components -> 'corroboration') = 'number'
             AND (score_components ->> 'corroboration')::numeric BETWEEN 0 AND 1))
    AND (score_components -> 'pathConcentration' IS NULL
         OR (jsonb_typeof(score_components -> 'pathConcentration') = 'number'
             AND (score_components ->> 'pathConcentration')::numeric BETWEEN 0 AND 1))
    AND (score_components -> 'persistence' IS NULL
         OR (jsonb_typeof(score_components -> 'persistence') = 'number'
             AND (score_components ->> 'persistence')::numeric BETWEEN 0 AND 1))
    AND (score_components -> 'outcomeProximity' IS NULL
         OR (jsonb_typeof(score_components -> 'outcomeProximity') = 'number'
             AND (score_components ->> 'outcomeProximity')::numeric BETWEEN 0 AND 1))
    /* Nothing but those six. */
    AND score_components - 'deviationMagnitude' - 'populationSize' - 'corroboration' - 'pathConcentration' - 'persistence' - 'outcomeProximity' = '{}'::jsonb
  )
);

/* Ordering a concept's findings by what to read first. Partial, because an
   unscored finding is never what that question is asking for. */
CREATE INDEX findings_by_score
  ON findings (organisation_id, concept_id, score DESC)
  WHERE score IS NOT NULL;
