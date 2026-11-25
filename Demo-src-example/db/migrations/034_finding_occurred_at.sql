-- 034_finding_occurred_at — when the thing happened, as opposed to when we
-- noticed.
--
-- §4.1 asks association analysis for temporal ordering "where timestamps
-- permit", and until this column there was nothing for that clause to permit.
--
-- ── Why not `detected_at` ───────────────────────────────────────────────────
--
-- `detected_at` records when a detector ran. Ordering two conditions by it
-- would report the order the engine happened to execute in as a fact about the
-- customer's business — and an artefact of scheduling is indistinguishable, on
-- screen, from a discovery about how their operation works. It is the most
-- plausible wrong answer available, which is exactly why a second column is
-- worth the migration.
--
-- ── Why it is nullable, and stays nullable ─────────────────────────────────
--
-- Most detectors have no event time to report. An outlier on an invoice total
-- is a fact about a number, not about a moment; a duplicate exists rather than
-- occurs. Only a detector reading a timestamp field knows one — sequence
-- violation, today, and the three that need Siloes when they arrive.
--
-- NULL MEANS THE ORDER IS UNKNOWN AND THE ASSOCIATION SAYS SO. That is the
-- honest output far more often than a guess, and `associations.temporal_order`
-- carries `unknown` as a first-class answer for this reason.

ALTER TABLE findings ADD COLUMN occurred_at timestamptz;

/*
 * Only the rows that have one, because the index exists for ordering
 * associations and a row with no timestamp can never participate in that.
 */
CREATE INDEX findings_occurred ON findings (organisation_id, occurred_at)
  WHERE occurred_at IS NOT NULL;
