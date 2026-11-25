/*
 * §2.3 — what each system calls the concept's fields.
 *
 * ── The step every cross-system answer needs and nothing recorded ──────────
 *
 * A concept already says which OBJECT each system holds it in, which column
 * identifies a row, and which columns to match on. It has never said that the
 * concept's `total` is `TotalAmt` in Netsuite and `Amount` in Sage — so a
 * question phrased in the concept's own words could not be translated into
 * anything a source understands, and the ontology was queryable only through
 * detectors, which are handed their field names one at a time.
 *
 * ── Derived, not typed ─────────────────────────────────────────────────────
 *
 * `engine/ontology/derive` already computes this and throws it away:
 * `canonicalField` turns `Invoice.TotalAmt` into `total`, and the comparison
 * holds canonical-to-real for every field of every object it looked at. It used
 * that to emit match keys in each system's own spelling and discarded the rest.
 * Confirmation stores the whole map now.
 *
 * DETERMINISTIC FROM THE MANIFEST, so every customer on the same connector gets
 * the same canonicalisation with nobody entering anything. What differs per
 * customer is the concept — which objects mean one thing here — and that is a
 * statement about a business rather than about a vendor's software.
 *
 * ── The concept's name is the key, the source's is the value ───────────────
 *
 * `{"total": "TotalAmt", "status": "Status__c"}`. One question names `total`
 * and every system it reaches translates it separately, including systems
 * connected later, which is why this cannot live in a connector: a connector
 * describes one system without reference to any other.
 */

ALTER TABLE concept_objects
  ADD COLUMN field_map jsonb NOT NULL DEFAULT '{}';

/*
 * FLAT, AND STRING TO STRING. A nested value would be a path expression, which
 * is a second query language living in a column nobody validates, and a number
 * or a boolean is not a column name. This is the only thing standing between
 * the map and somebody storing a transformation in it.
 *
 * A SQL/JSON PATH RATHER THAN A SUBQUERY, because a CHECK may not contain one —
 * 050 hit the same wall and named its keys one at a time, which is not open to
 * a map whose keys are the customer's own field names.
 */
ALTER TABLE concept_objects ADD CONSTRAINT concept_objects_field_map_flat CHECK (
  jsonb_typeof(field_map) = 'object'
  AND NOT jsonb_path_exists(field_map, '$.* ? (@.type() != "string")')
);
