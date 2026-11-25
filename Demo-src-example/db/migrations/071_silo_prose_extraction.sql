/*
 * 071 — reading documents with a model: the organisation's choice, and where a
 * value in a document with no pages was read.
 *
 * ── The carve-out is a row, not a flag on the organisation ─────────────────
 *
 * Import §8: document extraction "is a genuine exception to the rule that no
 * business data is sent to a model, and it is stated at enable time rather than
 * discovered in a security review." §13: `extraction_carveout_acknowledged`
 * "records who accepted that document contents go to a model, and when. That is
 * the row a security reviewer asks for."
 *
 * So the choice is who made it, when, and which version of the words they read.
 * Withdrawing it deletes the row, and the audit trail keeps both acts. A change
 * to the disclosure's text changes its version, and a row naming an older one
 * sends nothing until somebody reads the new words.
 *
 * ── A value in a Word document has no page ────────────────────────────────
 *
 * A PDF has pages and a value's place is a box on one. A Word document's text
 * has no layout that survives extraction, so a value's place is where its
 * passage sits in the text: an offset and a length. One or the other, never
 * neither.
 */

CREATE TABLE extraction_carveouts (
  organisation_id    uuid        PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
  acknowledged_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  disclosure_version text        NOT NULL CHECK (disclosure_version ~ '^[0-9a-f]{64}$'),
  acknowledged_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE extraction_carveouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_carveouts FORCE  ROW LEVEL SECURITY;
CREATE POLICY extraction_carveouts_tenant ON extraction_carveouts
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON extraction_carveouts TO silo_app;

ALTER TABLE silo_extractions ALTER COLUMN page DROP NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_x DROP NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_y DROP NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_width DROP NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_height DROP NOT NULL;

ALTER TABLE silo_extractions ADD COLUMN text_offset integer CHECK (text_offset IS NULL OR text_offset >= 0);
ALTER TABLE silo_extractions ADD COLUMN text_length integer CHECK (text_length IS NULL OR text_length > 0);

ALTER TABLE silo_extractions ADD CONSTRAINT silo_extractions_located CHECK (
  (page IS NOT NULL AND box_x IS NOT NULL AND box_y IS NOT NULL AND box_width IS NOT NULL AND box_height IS NOT NULL)
  OR (text_offset IS NOT NULL AND text_length IS NOT NULL)
);
