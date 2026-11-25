ALTER TABLE unresolved_pairs DROP CONSTRAINT IF EXISTS unresolved_pairs_canonical;
DROP TABLE IF EXISTS confirmed_resolutions;
DROP TABLE IF EXISTS concept_revisions;

DROP INDEX IF EXISTS concepts_name_live;
ALTER TABLE concepts ADD CONSTRAINT concepts_name_unique UNIQUE (organisation_id, name);

CREATE TABLE IF NOT EXISTS concept_markings (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      text        NOT NULL,
  marking_id      uuid        NOT NULL REFERENCES markings(id) ON DELETE RESTRICT,
  UNIQUE (organisation_id, concept_id, marking_id)
);
ALTER TABLE concept_markings ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_markings FORCE  ROW LEVEL SECURITY;
CREATE POLICY concept_markings_tenant ON concept_markings
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON concept_markings TO silo_app;
