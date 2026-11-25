/*
 * §2.2 — what a field looked like last time anybody profiled it.
 *
 * ── Why this table can exist at all ────────────────────────────────────────
 *
 * Stability is one of the signals derivation weighs: a field whose shape holds
 * still between runs is behaving like a key, and one whose distinctness
 * collapsed is being written by something new — so the agreement measured last
 * time is not evidence about now. It needs two observations, and one run has
 * one. This is where the first one waits.
 *
 * IT HOLDS THREE COUNTS AND NOTHING ELSE. A sketch of the distinct values — a
 * minhash, a bloom filter, a hashed key set — would answer a richer question
 * and would be a one-way function OF CUSTOMER VALUES sitting in this database.
 * This product's claim is that it stores no data, and a hashed identifier is an
 * identifier that has been hashed. A distinct ratio is as arguable as a row
 * count, which is to say not at all.
 *
 * THE COLUMN TYPES ARE THE GUARANTEE. There is nowhere here to put a value:
 * `rows` is an integer, the two ratios are bounded numerics, and the only text
 * is the names of the object and field — which are schema, already stored in
 * the manifest, and never anything read out of a record.
 *
 * ── One row per field, overwritten ─────────────────────────────────────────
 *
 * The comparison is between now and the last time, so nothing needs a history
 * and keeping one would be accumulating unbounded storage to answer a question
 * nobody asks. The row is replaced on every run.
 */

CREATE TABLE field_profiles (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

  object_name     text        NOT NULL CHECK (length(trim(object_name)) BETWEEN 1 AND 128),
  field_name      text        NOT NULL CHECK (length(trim(field_name)) BETWEEN 1 AND 256),

  /* How many rows the observation was taken over. Not the object's size. */
  rows_seen       integer     NOT NULL CHECK (rows_seen >= 0),
  /* Distinct values over present values. A key sits at 1. */
  distinct_ratio  numeric(5,4) NOT NULL CHECK (distinct_ratio BETWEEN 0 AND 1),
  /* Rows where the field held nothing, over rows seen. */
  absent_ratio    numeric(5,4) NOT NULL CHECK (absent_ratio BETWEEN 0 AND 1),

  observed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_profiles_unique UNIQUE (connection_id, object_name, field_name)
);

CREATE INDEX field_profiles_by_connection ON field_profiles (connection_id);

ALTER TABLE field_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_profiles FORCE  ROW LEVEL SECURITY;

CREATE POLICY field_profiles_tenant ON field_profiles
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON field_profiles TO silo_app;
