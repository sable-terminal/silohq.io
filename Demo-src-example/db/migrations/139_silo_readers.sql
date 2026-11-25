/*
 * Siloes — who, outside Silo, may read what a Silo keeps.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * A Silo that keeps concepts whole is a warehouse: every record of each, the
 * copies before, which record in one system is which in another. Until now
 * the only thing that could read it was Silo. An organisation that has it
 * wants its reporting tool to read it too.
 *
 * A row here is one Google identity — a person, a group or a service account —
 * that a super admin has said may read ONE Silo. In BigQuery that Silo then
 * has a dataset of its own holding nothing but views: the latest copy of each
 * kept concept, its past copies where they are kept, and what was worked out
 * from them. The identities here are given read access to that dataset and to
 * nothing else — never to the tables the copies are in, which hold every
 * batch and every other Silo's records beside them.
 *
 * ── A NAME AND AN ADDRESS, AND A DECISION SOMEBODY MADE ───────────────────
 *
 * `granted_by` is who decided. Nothing reads a Silo from outside because it
 * exists: no rows, no dataset, no access. Removing the last row removes the
 * dataset.
 */
CREATE TABLE silo_readers (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id         uuid        NOT NULL REFERENCES siloes(id) ON DELETE CASCADE,
  kind            text        NOT NULL CHECK (kind IN ('user', 'group', 'service_account')),
  /* Lower case, so one identity is one row however it was typed. */
  email           text        NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
  granted_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  granted_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT silo_readers_unique UNIQUE (silo_id, email)
);

ALTER TABLE silo_readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_readers FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_readers_tenant ON silo_readers
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON silo_readers TO silo_app;
