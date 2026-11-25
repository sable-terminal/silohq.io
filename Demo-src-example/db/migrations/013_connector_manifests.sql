-- 013_connector_manifests — the document that is the connector.
--
-- MANIFESTS BEFORE CONNECTIONS. A connection references a manifest version, so
-- the table it points at has to exist first.
--
-- ── The manifest stays a document ───────────────────────────────────────────
--
-- ONE `jsonb` COLUMN, VALIDATED BY ZOD AT THE APPLICATION BOUNDARY. Normalising
-- it into relational tables would mean a migration every time a pagination
-- strategy is added, and would put half the contract in the database and half in
-- TypeScript with nothing keeping them in step. §2 is explicit that the Zod
-- schema is the boundary; this column is storage.
--
-- ── Prebuilt manifests are global ───────────────────────────────────────────
--
-- `organisation_id` IS NULLABLE AND NULL MEANS SILO'S OWN. A prebuilt connector
-- ships with the product and is the same document for every customer; making it
-- tenant-scoped would copy the Salesforce manifest into five hundred
-- organisations and version each independently, so a fix would have to be
-- applied five hundred times.
--
-- The policy below permits that case EXPLICITLY rather than by omission, because
-- a null in a tenant predicate is the classic way a row becomes visible to
-- everyone by accident rather than by decision.

CREATE TABLE connector_manifests (
  id              uuid        PRIMARY KEY,

  /** Null means prebuilt and global. Otherwise the tenant that authored it. */
  organisation_id uuid        REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * The connector this is a version OF, stable across versions. Deliberately not
   * a foreign key: a manifest exists before anything is connected with it, and
   * several connections may use one manifest.
   */
  connector_key   text        NOT NULL CHECK (length(trim(connector_key)) BETWEEN 1 AND 128),
  version         integer     NOT NULL CHECK (version >= 1),

  document        jsonb       NOT NULL,

  /*
   * WHICH SHAPE OF MANIFEST THIS IS. You need this identification the first time
   * the Zod schema changes — without it, a five-year-old manifest is
   * indistinguishable from a malformed one and there is nothing to migrate
   * against.
   */
  schema_version  integer     NOT NULL CHECK (schema_version >= 1),

  /** Route 4 is a support ticket, not a value: it produces a prebuilt manifest. */
  source_route    text        NOT NULL CHECK (source_route IN ('prebuilt', 'ai', 'visual')),

  created_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz,
  superseded_by   uuid        REFERENCES connector_manifests(id) ON DELETE RESTRICT,

  /*
   * A DOCUMENT, NOT AN ARRAY OR A SCALAR. `jsonb` will happily store `[]` or
   * `3`, and a manifest that is a number fails much later and much less
   * legibly than it fails here.
   */
  CONSTRAINT manifest_is_object CHECK (jsonb_typeof(document) = 'object'),

  CONSTRAINT manifests_superseded_pair CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);

/*
 * Uniqueness has to be written twice because SQL treats NULLs as distinct, so a
 * single UNIQUE over a nullable `organisation_id` would not constrain the
 * prebuilt rows at all — the same hole that let two root scopes share a name.
 */
CREATE UNIQUE INDEX manifests_tenant_version
  ON connector_manifests (organisation_id, connector_key, version)
  WHERE organisation_id IS NOT NULL;

CREATE UNIQUE INDEX manifests_global_version
  ON connector_manifests (connector_key, version)
  WHERE organisation_id IS NULL;

CREATE INDEX manifests_current ON connector_manifests (connector_key)
  WHERE superseded_at IS NULL;

/*
 * GIN ON THE DOCUMENT, so "which connectors declare aggregate pushdown" is an
 * index lookup rather than a scan that deserialises every manifest in the table.
 * `jsonb_path_ops` is smaller and faster than the default for the containment
 * queries this will actually run.
 */
CREATE INDEX manifests_document ON connector_manifests USING GIN (document jsonb_path_ops);

/*
 * ── Immutability ───────────────────────────────────────────────────────────
 *
 * ENFORCED BY A TRIGGER, NOT BY CONVENTION. Every returned figure cites a
 * connector version in its lineage, so editing a manifest in place silently
 * changes the meaning of answers already given — and a comment saying "do not
 * update this" is not a mechanism.
 *
 * A manifest is frozen once it has been used, which is the moment a connection
 * points at it. Before that it is a draft being assembled by the AI or visual
 * route and must remain editable, or every keystroke in the builder would need
 * a new row.
 *
 * SUPERSEDING IS PERMITTED because it does not change what the document says.
 * It records that a newer version exists, which is exactly how a change is made.
 */
CREATE OR REPLACE FUNCTION manifests_refuse_edit_once_used() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.document IS DISTINCT FROM OLD.document
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.connector_key IS DISTINCT FROM OLD.connector_key
     OR NEW.version IS DISTINCT FROM OLD.version
  THEN
    IF EXISTS (SELECT 1 FROM connections c WHERE c.manifest_id = OLD.id) THEN
      RAISE EXCEPTION
        'Manifest % is in use and cannot be edited. Create a new version instead.', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END $$;

ALTER TABLE connector_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_manifests FORCE  ROW LEVEL SECURITY;

/*
 * TWO POLICIES, AND THE SECOND IS THE ONE THAT NEEDS SAYING OUT LOUD.
 *
 * A tenant sees its own manifests, and everybody sees the prebuilt ones. The
 * global case is `FOR SELECT` only: a customer must be able to READ the
 * Salesforce manifest and must never be able to write to it, and a policy
 * without the command restriction would grant both — because policies are
 * permissive and OR together.
 */
CREATE POLICY connector_manifests_tenant ON connector_manifests
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY connector_manifests_prebuilt ON connector_manifests
  FOR SELECT
  USING (organisation_id IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_manifests TO silo_app;
