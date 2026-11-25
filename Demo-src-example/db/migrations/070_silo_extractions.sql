/*
 * 070 — where a value that is not certain was read.
 *
 * Import §5: "An inferred or near value carries a flag in every representation
 * it appears in. Clicking it shows the extraction method, the source document
 * and the page, cell or location within it, the raw text the value was read
 * from, and the model's confidence."
 *
 * ── A reference, and deliberately not a second copy of the value ───────────
 *
 * §12 lists a value column here. It is left out on purpose. The value is
 * already held once, in the row store, keyed by this row's file, row reference
 * and field; a second copy in Postgres would be a second place a customer's
 * value lives, a second thing to purge, and a second line in the disclosure.
 * The raw text is not stored either: the page and the box are, and the text is
 * read back out of the file — which is held anyway, and goes when it goes —
 * when somebody opens the flag. So this table holds positions, a method and a
 * score, and nothing any customer wrote.
 *
 * ── Only values that are not certain ───────────────────────────────────────
 *
 * A column read from a spreadsheet has no flag, and so no row. That keeps this
 * table the size of the uncertainty rather than the size of the import.
 *
 * ── Confidence is a model's score, and only a model's ──────────────────────
 *
 * A value located beside its label has no score, and inventing one would give a
 * layout rule the authority of a number. `near` has none; `inferred`, from phase
 * five, has the model's.
 *
 * ── Confirmation ───────────────────────────────────────────────────────────
 *
 * Who confirmed a value, and when, sit here so a confirmed value's flag can say
 * so. The record of the act itself, with what the method was before, is phase
 * six's `extraction_confirmations`.
 */

CREATE TABLE silo_extractions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id         uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  source_id       uuid        NOT NULL REFERENCES silo_sources(id) ON DELETE RESTRICT,
  file_id         uuid        NOT NULL REFERENCES silo_files(id) ON DELETE RESTRICT,

  object_name     text        NOT NULL CHECK (object_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
  row_ref         text        NOT NULL CHECK (length(row_ref) BETWEEN 1 AND 128),
  field_name      text        NOT NULL CHECK (field_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),

  method          text        NOT NULL CHECK (method IN ('near', 'inferred')),
  confidence      numeric(4, 3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),

  page            integer     NOT NULL CHECK (page >= 1),
  box_x           numeric     NOT NULL,
  box_y           numeric     NOT NULL,
  box_width       numeric     NOT NULL CHECK (box_width >= 0),
  box_height      numeric     NOT NULL CHECK (box_height >= 0),

  confirmed_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT silo_extractions_scored_by_a_model CHECK ((method = 'inferred') = (confidence IS NOT NULL)),
  CONSTRAINT silo_extractions_confirmed_shape CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT silo_extractions_one_per_value UNIQUE (file_id, object_name, row_ref, field_name)
);

CREATE INDEX silo_extractions_by_object ON silo_extractions (source_id, object_name);

ALTER TABLE silo_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_extractions FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_extractions_tenant ON silo_extractions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_extractions TO silo_app;
