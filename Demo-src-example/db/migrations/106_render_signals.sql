/*
 * 106 — the structure a drawing decision was made from.
 *
 * ── §11: "archetype_overridden carries the RESULT STRUCTURE and both
 * archetypes. It is the feedback that tells you precedence is wrong, and there
 * is no other source for it." ─────────────────────────────────────────────
 *
 * An override arrives later than the selection and by a different route: the
 * person looked at what was drawn, disagreed, and picked something else. By
 * then the result is gone — §1 says the render layer receives a result and §10
 * says it never stores one — so the structure has to have been kept at
 * selection time or it cannot be in the override's audit row at all.
 *
 * ── AND IT IS NOT A RESULT ────────────────────────────────────────────────
 *
 * §10 lists this table's columns and ends "Nothing else. The render layer
 * stores decisions about presentation AND NEVER RESULTS." That last sentence is
 * what "nothing else" is for, and the signals of §4.1 are not results: a row
 * count, a measure count, which measures two systems disagreed about BY FIELD
 * PATH, whether there was a time field, whether the edges had a direction or a
 * cycle. Counts and booleans. No figure, no entity, no field contents.
 *
 * THE FIELD PATHS ARE THE ONE THING WORTH PAUSING ON. A contested measure is
 * named by its path — `invoice.total` — which is schema rather than data, and
 * the same string already appears in `field_policies`, `concept_objects` and
 * every audit row that records which fields a mutation touched.
 *
 * ── WHY NOT HAVE THE CALLER SEND IT AT OVERRIDE TIME ──────────────────────
 *
 * Because §4.3 makes the override rate "the only measure of whether precedence
 * is right", and a rate computed from structures the client restated is a rate
 * measuring the client. The server chose the archetype from these signals; the
 * same signals are what its choice should be judged against.
 */

ALTER TABLE render_selections
  ADD COLUMN signals jsonb NOT NULL DEFAULT '{}'::jsonb;

/*
 * §4.3's override rate already has its index: 037 built
 * `render_selections_overridden` on (organisation_id, chosen, overridden_to)
 * where an override exists, which is the grouping that question needs and
 * carries the destination as well. Adding a narrower one beside it would be two
 * indexes for one query.
 */
