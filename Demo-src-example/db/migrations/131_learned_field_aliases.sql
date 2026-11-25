/*
 * §2.3 — what a system calls something, learned from an answer rather than typed.
 *
 * ── What this exists to stop being true ────────────────────────────────────
 *
 * A concept spanning two systems read each system's fields by the names the
 * naming convention gave them. One system's `town` and another's `city` were
 * therefore two fields, however alike their values: a question about the city
 * reached one system and reported the other as not holding one.
 *
 * Nobody can list in advance every word every system uses for the same thing,
 * and nobody should have to. The model that writes an answer up sees both
 * fields side by side and says they hold the same thing; Silo checks that
 * against the records the answer holds, and what survives is kept here, so the
 * next question reads them as one field.
 *
 * ── The same table, because it is the same statement ───────────────────────
 *
 * 056 stores "this system's `amt_gross` is our `total`", said by a person. A
 * learned match is that sentence said by an answer. One table means one place
 * to look, one screen that lists them, and one way to take one back.
 *
 * WHAT DIFFERS IS WHO SAID IT, and that decides two things: a learned row never
 * replaces one a person declared, and — unlike a declared one, which reaches
 * only concepts confirmed afterwards — it is applied when a question is read
 * and never written into a concept, so removing it restores exactly what was
 * confirmed.
 *
 * ── Names and counts, never values ─────────────────────────────────────────
 *
 * `compared` and `agreed` are how many of the answer's records held both
 * fields and how many of those held the same thing. They are the evidence the
 * match was accepted on, shown beside it. No value read from a record is
 * stored, and there is no column that could hold one.
 */

ALTER TABLE field_aliases
  ADD COLUMN origin   text    NOT NULL DEFAULT 'declared'
    CHECK (origin IN ('declared', 'learned')),
  ADD COLUMN compared integer CHECK (compared IS NULL OR compared >= 0),
  ADD COLUMN agreed   integer CHECK (agreed IS NULL OR agreed >= 0);

/*
 * EVIDENCE BELONGS TO A LEARNED ROW AND TO NO OTHER. A declared alias is a
 * person's word and carries no counts; a learned one without them is a match
 * nobody could later be shown the reason for.
 */
ALTER TABLE field_aliases ADD CONSTRAINT field_aliases_evidence CHECK (
  (origin = 'declared' AND compared IS NULL AND agreed IS NULL)
  OR (origin = 'learned' AND compared IS NOT NULL AND agreed IS NOT NULL AND agreed <= compared)
);
