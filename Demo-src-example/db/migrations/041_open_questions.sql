-- 041_open_questions — an unresolved pair with only one side is still a question.
--
-- ── The constraint that made the table unwritable ───────────────────────────
--
-- 030 declared `value_ref_b text NOT NULL CHECK (length(trim(value_ref_b))
-- BETWEEN 1 AND 512)`, and the resolver has always emitted `''` for it: the
-- question it records is "this invoice has no counterpart in Sage", which names
-- one side and asks about the other. So every detector run that found an
-- unresolved pair has failed at the insert since the table existed.
--
-- Nothing caught it because the database-backed suites skip without
-- `TEST_APP_DATABASE_URL`. That is now three runtime failures from the same
-- cause.
--
-- ── And the canonical ordering was wrong for those questions ───────────────
--
-- 039 added `connection_a < connection_b` to stop the same pair being recorded
-- twice mirrored. That is right when both sides are named — "A is B" and "B is
-- A" are one fact — and WRONG when only one is.
--
-- "This row in Netsuite has no counterpart in Sage" and "this row in Sage has
-- no counterpart in Netsuite" are two different questions about two different
-- records. Ordering them by connection would swap the known reference into the
-- empty column and make the pair unreadable.

ALTER TABLE unresolved_pairs DROP CONSTRAINT unresolved_pairs_canonical;

ALTER TABLE unresolved_pairs
  DROP CONSTRAINT IF EXISTS unresolved_pairs_value_ref_b_check;

/*
 * EMPTY MEANS "NOBODY HAS NAMED THE OTHER SIDE YET", which is the state a
 * question starts in. The model filling it in, or a person doing so by hand, is
 * what moves it on — and `resolution.service.confirm` refuses to promote a pair
 * that still has an empty side, because there is nothing to map it to.
 */
ALTER TABLE unresolved_pairs
  ADD CONSTRAINT unresolved_pairs_ref_b_bounded
    CHECK (length(value_ref_b) <= 512);

/*
 * Canonical ONLY once both sides are named. Until then the pair is directional
 * on purpose: side A is the row that exists, side B is where it is missing.
 */
ALTER TABLE unresolved_pairs
  ADD CONSTRAINT unresolved_pairs_canonical
    CHECK (trim(value_ref_b) = '' OR connection_a < connection_b);

/*
 * The model may only fill in the side that was empty. Without this, a proposal
 * could rewrite the reference that was actually read out of a source — which is
 * the one value in the row that came from the customer's system rather than
 * from a guess.
 */
ALTER TABLE unresolved_pairs
  ADD CONSTRAINT unresolved_pairs_ref_a_named
    CHECK (length(trim(value_ref_a)) BETWEEN 1 AND 512);
