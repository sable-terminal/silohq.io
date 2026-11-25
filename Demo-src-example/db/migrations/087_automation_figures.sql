/*
 * 087 — since when has this figure been the same.
 *
 * ── §3: "Has not changed in a stated period" ───────────────────────────────
 *
 * The other two value conditions compare this run against the last one, which
 * `previous_figure` already answers. This one asks a different question — how
 * LONG something has been still — and no pair of consecutive readings can
 * answer it. A figure that has been 400 for six months and a figure that
 * became 400 yesterday look identical from two runs.
 *
 * ── WHY NOT A HISTORY TABLE ────────────────────────────────────────────────
 *
 * The obvious alternative is keeping every reading and asking when it last
 * moved. That is a time series of a customer's own figures accumulating in the
 * control plane, growing with every run of every automation, for a question
 * answerable by one timestamp. Keeping the instant the figure last changed is
 * the whole of what §3 asks for.
 */

ALTER TABLE automation_run_state
  ADD COLUMN figure_unchanged_since timestamptz;

COMMENT ON COLUMN automation_run_state.figure_unchanged_since IS
  'When previous_figure last took a different value. Null until a figure has been seen twice.';
