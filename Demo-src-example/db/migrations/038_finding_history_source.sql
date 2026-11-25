-- 038_finding_history_source — where a finding's history was read from.
--
-- §3 — the three history detectors are resolved against capability rather than
-- storage: the source system first, a Silo second, both merged third. Which of
-- those actually answered is not an implementation detail, it is lineage.
--
-- ── Why it has to be on the row ────────────────────────────────────────────
--
-- "This claim has been open 31 days against a norm of 4" is a different claim
-- depending on where the norm came from. Read live from the source it is the
-- current truth. Read from a Silo it is the truth as of whenever the Silo last
-- collected, and somebody challenging the finding needs to know which.
--
-- `both` IS A REAL ANSWER AND NOT A HEDGE. The Silo supplied the baseline and
-- the source supplied the current period, which is the arrangement that makes a
-- six-month question answerable against a system that keeps ninety days.
--
-- NULL FOR THE OTHER SEVEN, because they read a snapshot and there is no
-- history for them to have come from. A column defaulted to 'source' would
-- claim every duplication finding consulted history.

ALTER TABLE findings
  ADD COLUMN history_source text CHECK (history_source IN ('source', 'silo', 'both'));
