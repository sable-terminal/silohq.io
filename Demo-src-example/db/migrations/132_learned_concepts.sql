/*
 * §2.4 — a concept across systems that Silo joined itself.
 *
 * ── What had to stop being true ────────────────────────────────────────────
 *
 * Derivation has always found that two systems hold the same things — it reads
 * a page of each side's identifiers and counts the ones both hold. Then it
 * stopped, and waited for a person to press Derive, read the evidence and
 * confirm. A customer who connected a CRM and a ledger and asked about their
 * customers was answered from one system at a time until somebody found the
 * screen that says they are the same customers.
 *
 * Nobody should have to. Where the records themselves bear a proposal out —
 * enough of them match on the proposed key, and SOMETHING ELSE about the
 * matched records agrees too — Silo makes the concept, says so, and anybody who
 * may confirm concepts can take it back.
 *
 * ── `learned`, kept apart from `confirmed` ─────────────────────────────────
 *
 * Who decided is the difference between a concept a person looked at and one
 * the records were left to speak for, and every screen that shows a concept
 * says which. The proposal it came from is decided `learned` for the same
 * reason: the rate at which derivation is confirmed, corrected or rejected is
 * the measure of derivation, and Silo agreeing with itself must not count as a
 * person agreeing with it.
 *
 * A PROPOSAL THE RECORDS DO NOT BEAR OUT IS LEFT IN THE QUEUE, exactly as it
 * always was. This adds a way for the obvious ones not to wait; it takes
 * nothing away from the ones that should.
 */

ALTER TABLE concepts DROP CONSTRAINT concepts_origin_check;
ALTER TABLE concepts ADD CONSTRAINT concepts_origin_check
  CHECK (origin IN ('confirmed', 'corrected', 'manual', 'system', 'learned'));

ALTER TABLE concept_proposals DROP CONSTRAINT concept_proposals_decision_check;
ALTER TABLE concept_proposals ADD CONSTRAINT concept_proposals_decision_check
  CHECK (decision IS NULL OR decision IN ('confirmed', 'corrected', 'rejected', 'learned'));

ALTER TABLE concept_proposals DROP CONSTRAINT concept_proposals_concept_needs_yes;
ALTER TABLE concept_proposals ADD CONSTRAINT concept_proposals_concept_needs_yes
  CHECK (concept_id IS NULL OR decision IN ('confirmed', 'corrected', 'learned'));
