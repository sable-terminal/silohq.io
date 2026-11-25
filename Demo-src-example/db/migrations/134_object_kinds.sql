/*
 * 130 — what a system's records are ABOUT, read from its field names alone.
 *
 * ── What this exists to stop being true ────────────────────────────────────
 *
 * With the web on, Silo looks up the organisations an answer names — and never
 * a person. Which records are organisations was decided by lists of English
 * words: a concept called something like "company", a field called `website`
 * or `industry`. A table named `tbl_cust_m`, or a system whose fields are in
 * German, matched nothing and got no web context at all, however plainly its
 * records were companies.
 *
 * Nobody can list every word every system uses. So where the English words
 * are silent and the records carry what looks like a web address, a model is
 * shown the object's NAME and its FIELD NAMES — never a record — and says
 * whether its records are organisations, people, or neither. That reading is
 * kept here, so it is asked once per object and not once per answer.
 *
 * ── It can only ever make the guard stricter, or agree with the records ───
 *
 * `person` stops anything from that object being looked up, whatever else
 * says otherwise. `organisation` admits one only together with the records
 * themselves looking like organisations — and never past an email address or a
 * phone number among their values. So a wrong reading here cannot, on its own,
 * send a person's name to the web.
 *
 * ── Names, and a fingerprint of names ──────────────────────────────────────
 *
 * `fields_hash` is a hash of the field names the reading was made from, so a
 * connector that learns more fields is read again. No value from any record is
 * here, and nothing here could hold one.
 */
CREATE TABLE object_kinds (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  object_name     text        NOT NULL CHECK (length(trim(object_name)) BETWEEN 1 AND 128),

  kind            text        NOT NULL CHECK (kind IN ('organisation', 'person', 'other')),
  fields_hash     text        NOT NULL CHECK (fields_hash ~ '^[0-9a-f]{64}$'),
  decided_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT object_kinds_unique UNIQUE (connection_id, object_name)
);

ALTER TABLE object_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_kinds FORCE  ROW LEVEL SECURITY;

CREATE POLICY object_kinds_tenant ON object_kinds
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON object_kinds TO silo_app;
