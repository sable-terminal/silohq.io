/*
 * §5 — telling a second RUN apart from a second SOURCE PAIR.
 *
 * ── The miscount 050 shipped ───────────────────────────────────────────────
 *
 * `raised_count` was meant to answer "how many runs have raised this same
 * fact", and it counted upserts. The disagreement detector compares every pair
 * of contributing sources, so a concept spanning three systems compares three
 * pairs and upserts the same (detector, concept, entity, measure) row three
 * times — in ONE run.
 *
 * So a finding raised for the very first time arrived with `raised_count = 3`,
 * and §5's scoring read that as three runs of persistence: the exact "absent is
 * not zero" failure the persistence component was written to avoid, in the
 * opposite direction. A brand new finding was scored as an old one.
 *
 * ── Why a run id rather than a timestamp ───────────────────────────────────
 *
 * Two upserts in one run are microseconds apart and two runs can be too — a
 * scheduled run and somebody pressing the button land together often enough
 * that a time window would be a guess. The run that wrote the row is a fact,
 * and comparing it is exact.
 *
 * NULLABLE, because every row written before this migration has no run to name
 * and inventing one would claim a fact nobody recorded. Those rows increment on
 * their next raise, which is correct from that point on.
 */

ALTER TABLE findings ADD COLUMN last_run_id uuid;

COMMENT ON COLUMN findings.last_run_id IS
  'The detector run that last raised this finding. `raised_count` increments only when a raise carries a different one, so comparing three source pairs in one run counts once.';
