/*
 * §7.3 — which field a question about time is about.
 *
 * ── Three fields, three different answers, and nothing declared any ────────
 *
 * "Last quarter's invoices" means something different against each of created,
 * modified, occurred and effective, and the difference is usually material: an
 * invoice raised in March, amended in April and dated to February appears in
 * three different quarters depending which field the question meant.
 *
 * Nothing in this schema said which. The only time fields anywhere are the ones
 * a detector run is HANDED — `startField`, `dateField` — which are arguments to
 * one detector, not a property of the concept. So a compiler had nothing to
 * resolve a date range against.
 *
 * ── Named in the concept's own words, like every other field ───────────────
 *
 * These are entries in the concept's field map, not source columns: one
 * statement covers every system it spans, including systems connected later.
 * `raised_at` here, `CreatedDate` in Netsuite, `date_created` in Sage.
 *
 * ── The default is what makes a question answerable without asking ─────────
 *
 * Where a concept has one time field it is the default. Where it has several
 * and somebody has said which is usual, a question that does not name one uses
 * it AND THE ANSWER SAYS SO. Where it has several and nobody has said, that is
 * an ambiguity the compiler surfaces rather than a guess it makes — the same
 * treatment as two concepts that could both be meant.
 */

CREATE TABLE concept_time_fields (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /** The concept's own name for the field. */
  field_path      text        NOT NULL CHECK (length(trim(field_path)) BETWEEN 1 AND 256),

  /*
   * WHAT KIND OF TIME IT IS. Not free text: a question about when something
   * HAPPENED is a different question from when a record was TOUCHED, and a
   * compiler choosing between them needs the difference to be a closed set.
   */
  kind            text        NOT NULL CHECK (kind IN ('occurred', 'created', 'modified', 'effective')),

  /*
   * THE ONE A QUESTION MEANS WHEN IT DOES NOT SAY. At most one per concept —
   * two defaults is not a richer configuration, it is a question with two
   * answers and no way to choose.
   */
  is_default      boolean     NOT NULL DEFAULT false,

  declared_by     uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  declared_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT concept_time_fields_unique UNIQUE (concept_id, field_path)
);

/* At most one default per concept, enforced rather than remembered. */
CREATE UNIQUE INDEX concept_time_fields_one_default
  ON concept_time_fields (concept_id) WHERE is_default;

CREATE INDEX concept_time_fields_by_concept ON concept_time_fields (concept_id);

ALTER TABLE concept_time_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_time_fields FORCE  ROW LEVEL SECURITY;

CREATE POLICY concept_time_fields_tenant ON concept_time_fields
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON concept_time_fields TO silo_app;
