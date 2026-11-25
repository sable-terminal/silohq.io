-- 022_connector_drafts — a connector being built, which is not yet a connector.
--
-- THE DOCUMENT HERE IS NOT VALIDATED AND MUST NOT BE. A draft is half-finished
-- by definition: the visual builder saves after every field, and §5 requires
-- that a half-built AI connector "opens here rather than being discarded" — the
-- single behaviour that stops the AI route being a dead end when it fails, which
-- it will. A store that only accepted valid manifests could hold neither.
--
-- WHICH MAKES THE SEPARATION FROM `connector_manifests` THE POINT OF THIS TABLE
-- rather than an organisational nicety. The engine loads from `connections` to
-- `connector_manifests` and has no path to this table at all, so a draft cannot
-- be executed however broken it is. Publishing is the only crossing, it goes
-- through the Zod schema on the way, and what lands on the other side is
-- immutable.

CREATE TABLE connector_drafts (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /*
   * A PARTIAL MANIFEST. `jsonb` with no shape imposed, because the shape is the
   * Zod schema's business and it changes with the schema version rather than
   * with a migration.
   */
  document        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  /*
   * WHICH ROUTE THIS CAME FROM, and 'prebuilt' is absent on purpose: Silo's own
   * connectors are written as files and reviewed as files, and never sit in a
   * customer's draft table.
   */
  source_route    text        NOT NULL CHECK (source_route IN ('ai', 'visual')),

  /*
   * WHERE THE AI BUILDER STOPPED, when it did. §5 — "the builder stops and names
   * the stage that failed. It never emits a manifest it could not execute."
   * Naming the stage is what makes the draft recoverable rather than merely
   * broken: somebody opening it needs to know whether to fix a credential or fix
   * a mapping.
   */
  failed_stage    text        CHECK (failed_stage IN ('parse', 'probe', 'reconcile', 'map', 'verify')),

  /*
   * THE LAST MANIFEST THIS DRAFT PRODUCED, not a lock. Editing on towards the
   * next version is the ordinary way a connector is maintained — this exists so
   * the builder can say "version 3 is what is running, and you have changed
   * things since" rather than silently showing something other than what
   * executes.
   */
  published_manifest_id uuid  REFERENCES connector_manifests(id) ON DELETE SET NULL,
  published_at    timestamptz,

  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Both or neither. A publish time with nothing published, or the reverse, is a
  -- draft whose history cannot be read back.
  CONSTRAINT drafts_published_together CHECK (
    (published_manifest_id IS NULL) = (published_at IS NULL)
  )
);

CREATE INDEX connector_drafts_by_org ON connector_drafts (organisation_id, updated_at DESC);

CREATE FUNCTION connector_drafts_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connector_drafts_touched
  BEFORE UPDATE ON connector_drafts
  FOR EACH ROW EXECUTE FUNCTION connector_drafts_touch();

ALTER TABLE connector_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_drafts FORCE  ROW LEVEL SECURITY;

CREATE POLICY connector_drafts_tenant ON connector_drafts
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_drafts TO silo_app;
