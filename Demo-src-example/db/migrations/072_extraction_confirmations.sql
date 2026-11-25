/*
 * 072 — a person confirming what a document said.
 *
 * Import §5: "A user may confirm an extracted value. On confirmation it becomes
 * certain, permanently, for that value. Same shape as the unresolved pair loop
 * in the ontology: the machine proposes, a person decides, and the decision is
 * exact thereafter." §12: `extraction_confirmations` — "extraction, membership,
 * previous method, confirmed at."
 *
 * ── Once per value ─────────────────────────────────────────────────────────
 *
 * A confirmed value is not confirmed again, so there is one row per value and
 * one answer to "who decided this was right".
 *
 * ── Permanent for the value, not beyond it ─────────────────────────────────
 *
 * Reading the same file again does not undo it. Deleting the file, the object,
 * the concept or the Silo deletes the value, and its confirmation with it, so
 * nothing here outlives what it is about. The audit trail's
 * `extraction_confirmed` stays, and says who and when without the value.
 *
 * ── No value here either ───────────────────────────────────────────────────
 *
 * What was confirmed is identified by its extraction, which is a position; the
 * value itself stays in the row store, once.
 */

CREATE TABLE extraction_confirmations (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  extraction_id   uuid        NOT NULL REFERENCES silo_extractions(id) ON DELETE RESTRICT,
  file_id         uuid        NOT NULL REFERENCES silo_files(id) ON DELETE RESTRICT,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  previous_method text        NOT NULL CHECK (previous_method IN ('near', 'inferred')),
  confirmed_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extraction_confirmations_once UNIQUE (extraction_id)
);

CREATE INDEX extraction_confirmations_by_file ON extraction_confirmations (file_id);

ALTER TABLE extraction_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_confirmations FORCE  ROW LEVEL SECURITY;
CREATE POLICY extraction_confirmations_tenant ON extraction_confirmations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON extraction_confirmations TO silo_app;
