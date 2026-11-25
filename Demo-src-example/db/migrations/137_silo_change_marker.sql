/*
 * Siloes — the field a system uses to say a record has changed, worked out.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * A copy is as the systems stood when it was made. A question asked at four in
 * the afternoon of a copy made at two in the morning is fourteen hours behind,
 * and says so — but it could read live just the records that changed since,
 * and lay them over the copy, if it knew how to ask a system for those.
 *
 * Most systems can be asked: they keep a "last modified" on each record. Which
 * field that is differs in every one of them, and is not something to be
 * guessed from its name.
 *
 * ── WORKED OUT FROM THE SYSTEM'S OWN RECORDS, NEVER FROM A NAME ───────────
 *
 * Each time a copy finishes there are two: this one and the one before. Every
 * record that is new or different between them is known. A date field is the
 * one a system marks change with if EVERY such record carries a value in it
 * later than the earlier copy — which is exactly the question "would asking
 * for records with this field after the copy have found everything that
 * changed?", answered on the day's real changes.
 *
 * `changed_field` is that field, and `changed_evidence` how many changed
 * records have borne it out. One changed record that the field did not mark
 * withdraws it; it is looked at again at every copy.
 *
 * A NAME, AND A COUNT. Nothing of a record is kept here.
 */
ALTER TABLE silo_holdings
  ADD COLUMN changed_field    text    CHECK (changed_field IS NULL OR length(trim(changed_field)) BETWEEN 1 AND 128),
  ADD COLUMN changed_evidence integer NOT NULL DEFAULT 0 CHECK (changed_evidence >= 0),
  ADD CONSTRAINT silo_holdings_marker_shape CHECK (changed_field IS NOT NULL OR changed_evidence = 0);
