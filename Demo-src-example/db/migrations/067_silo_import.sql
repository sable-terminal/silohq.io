/*
 * 067 — Siloes. Import: files, structured into a source the query layer cannot
 * tell apart from any other.
 *
 * ── A Silo is a source ─────────────────────────────────────────────────────
 *
 * An import carries a manifest, declares objects and fields, and answers
 * queries through the same path as a connector. So an import is a CONNECTION:
 * a row in `connections` whose manifest names the `silo_import` transport. Grants,
 * clearance, concept derivation and the query layer then treat it exactly as
 * they treat Sage — which is what lets a decade of exports join live systems
 * through the ontology with no special case anywhere.
 *
 * The distinguishing property is the destination. A connector reads data where
 * it lives; a Silo holds a copy. The tables below are that copy's bookkeeping:
 * where the files came from, how they are structured, what arrived, and — for
 * the Postgres stand-in — the rows themselves.
 */

/* ── The transport ───────────────────────────────────────────────────────── */

/*
 * NO AUTHORING ROUTE. `routes` is what the connector builder offers, and a
 * Silo import is never built there: it is published from a structuring
 * definition, by the import service, so the dropdown must not list it.
 */
INSERT INTO connector_transports (kind, protocol, routes, description) VALUES
  ('silo_import', 'silo', '{}', 'A Silo: imported files, structured by a definition and held by Silo');

/* ── The structuring definition ──────────────────────────────────────────── */

/*
 * MIRRORS `connector_manifests`, and for the same reasons. Versioned, because a
 * definition that changed while files were being read under it would make two
 * rows from one file mean different things. Immutable once published, enforced
 * by trigger rather than by the service remembering. Prebuilt definitions ship
 * with no organisation, readable by everybody, owned by nobody.
 *
 * A DRAFT IS EDITABLE AND UNVERSIONED. The version is assigned at publish, so
 * abandoned drafts do not burn version numbers and "version 4" always means the
 * fourth thing that was actually used.
 *
 * THE PROBE IS RECORDED ON THE DEFINITION. §4: "A definition that cannot
 * extract from the files it was built for fails at authoring rather than at
 * query time." Publishing requires a passing probe over this exact document —
 * the hash is what stops an edit after the probe from riding on its result.
 */
CREATE TABLE silo_definitions (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        REFERENCES organisations(id) ON DELETE RESTRICT,
  definition_key       text        NOT NULL CHECK (length(trim(definition_key)) BETWEEN 1 AND 128),
  version              integer     CHECK (version IS NULL OR version >= 1),
  name                 text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  source_route         text        NOT NULL CHECK (source_route IN ('ai', 'builder', 'prebuilt')),
  document             jsonb       NOT NULL DEFAULT '{}'::jsonb,

  status               text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  probed_file_id       uuid,
  probed_document_hash text,
  probe_passed         boolean     NOT NULL DEFAULT false,

  /* The connector manifest this definition published, which the connection points at. */
  manifest_id          uuid        REFERENCES connector_manifests(id) ON DELETE RESTRICT,

  created_by           uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz,

  CONSTRAINT silo_definitions_is_object CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT silo_definitions_published_shape CHECK (
       (status = 'draft'     AND version IS NULL     AND published_at IS NULL)
    OR (status = 'published' AND version IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX silo_definitions_tenant_version
  ON silo_definitions (organisation_id, definition_key, version)
  WHERE organisation_id IS NOT NULL AND version IS NOT NULL;
CREATE UNIQUE INDEX silo_definitions_prebuilt_version
  ON silo_definitions (definition_key, version)
  WHERE organisation_id IS NULL AND version IS NOT NULL;

ALTER TABLE silo_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_definitions FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_definitions_tenant ON silo_definitions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY silo_definitions_prebuilt ON silo_definitions
  FOR SELECT USING (organisation_id IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_definitions TO silo_app;

CREATE OR REPLACE FUNCTION silo_definitions_refuse_edit_once_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'Definition % is published and cannot be deleted.', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' AND (
       NEW.document       IS DISTINCT FROM OLD.document
    OR NEW.version        IS DISTINCT FROM OLD.version
    OR NEW.definition_key IS DISTINCT FROM OLD.definition_key
    OR NEW.status         IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'Definition % is published and cannot be edited. Draft a new version.', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER silo_definitions_immutable_once_published
  BEFORE UPDATE OR DELETE ON silo_definitions
  FOR EACH ROW EXECUTE FUNCTION silo_definitions_refuse_edit_once_published();

/* ── Where files come from ───────────────────────────────────────────────── */

/*
 * §2 — ONE-OFF UPLOAD OR WATCHED LOCATION. "The difference is trigger, not
 * treatment", so both are one table and one pipeline; `location` exists only
 * for the one that has a location.
 *
 * `connection_id` IS THE SOURCE AS A CONNECTOR. Set when its first definition
 * is published, and unique: one source, one connection, whatever versions of
 * its definition come and go.
 */
CREATE TABLE silo_sources (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id         uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  kind            text        NOT NULL CHECK (kind IN ('upload', 'watched')),
  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  location        text        CHECK (location IS NULL OR length(location) BETWEEN 1 AND 1024),
  definition_id   uuid        REFERENCES silo_definitions(id) ON DELETE RESTRICT,
  connection_id   uuid        UNIQUE REFERENCES connections(id) ON DELETE RESTRICT,
  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,

  CONSTRAINT silo_sources_location_shape CHECK ((kind = 'watched') = (location IS NOT NULL)),
  CONSTRAINT silo_sources_name_unique UNIQUE (silo_id, name)
);

ALTER TABLE silo_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_sources FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_sources_tenant ON silo_sources
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON silo_sources TO silo_app;

/* ── What arrived ────────────────────────────────────────────────────────── */

/*
 * A FILE EXISTS BEFORE IT ARRIVES. The row is written when an upload is
 * requested, so the object key, the declared size and the expiry of the signed
 * URL are fixed before any bytes move — and a file that never arrives is a row
 * that says so rather than an object nobody can account for.
 *
 * THE SIZE CAP IS THE SCHEMA'S. A file is read into memory to be structured,
 * and 64 MiB is where that stops being reasonable; a validator is a promise and
 * this is a constraint.
 */
CREATE TABLE silo_files (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id           uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  source_id         uuid        NOT NULL REFERENCES silo_sources(id) ON DELETE RESTRICT,

  object_key        text        NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 1024),
  filename          text        NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  declared_bytes    bigint      NOT NULL CHECK (declared_bytes BETWEEN 1 AND 67108864),
  size_bytes        bigint      CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 67108864),
  content_type      text,

  status            text        NOT NULL DEFAULT 'awaiting_upload'
                      CHECK (status IN ('awaiting_upload', 'received', 'processing', 'processed', 'failed')),
  failure_code      text        CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
  rows_extracted    integer     CHECK (rows_extracted IS NULL OR rows_extracted >= 0),
  rows_rejected     integer     CHECK (rows_rejected IS NULL OR rows_rejected >= 0),

  upload_expires_at timestamptz NOT NULL,
  uploaded_by       uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  received_at       timestamptz,
  processed_at      timestamptz,

  CONSTRAINT silo_files_received_shape CHECK (status = 'awaiting_upload' OR received_at IS NOT NULL),
  CONSTRAINT silo_files_failure_explained CHECK (status <> 'failed' OR failure_code IS NOT NULL)
);

CREATE INDEX silo_files_by_source ON silo_files (source_id, status);
CREATE INDEX silo_files_by_age ON silo_files (silo_id, received_at);

ALTER TABLE silo_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_files FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_files_tenant ON silo_files
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_files TO silo_app;

/* A purged probe file invalidates the probe, which is not history worth keeping. */
ALTER TABLE silo_definitions ADD CONSTRAINT silo_definitions_probed_file
  FOREIGN KEY (probed_file_id) REFERENCES silo_files(id) ON DELETE SET NULL;

/* ── The rows, in the Postgres stand-in ──────────────────────────────────── */

/*
 * §7 SAYS BIGQUERY, AND IN PRODUCTION IT IS. This table is the same row store
 * for development, tests, and any deployment where BigQuery is not configured —
 * behind one interface, so the query path is identical and only the storage
 * underneath differs.
 *
 * `record`, NOT `values` — `values` is a reserved word. `methods` holds the
 * extraction method for every field that is not certain; for a spreadsheet it
 * is always empty.
 */
CREATE TABLE silo_rows (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id         uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  source_id       uuid        NOT NULL REFERENCES silo_sources(id) ON DELETE RESTRICT,
  file_id         uuid        NOT NULL REFERENCES silo_files(id) ON DELETE RESTRICT,
  object_name     text        NOT NULL CHECK (length(object_name) BETWEEN 1 AND 128),
  row_ref         text        NOT NULL CHECK (length(row_ref) BETWEEN 1 AND 256),
  record          jsonb       NOT NULL,
  methods         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at     timestamptz NOT NULL,

  CONSTRAINT silo_rows_record_is_object CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT silo_rows_methods_is_object CHECK (jsonb_typeof(methods) = 'object')
);

CREATE INDEX silo_rows_by_object ON silo_rows (source_id, object_name, received_at);
CREATE INDEX silo_rows_by_file ON silo_rows (file_id);

ALTER TABLE silo_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_rows FORCE  ROW LEVEL SECURITY;
CREATE POLICY silo_rows_tenant ON silo_rows
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON silo_rows TO silo_app;

/* ── §9 Metering ─────────────────────────────────────────────────────────── */

/*
 * Extraction operations, per Silo, from day one. A model run per document is the
 * cost class of generating a connector, and adding the count after a customer
 * holds a large Silo is the conversation §9 exists to avoid.
 */
ALTER TABLE siloes ADD COLUMN extraction_operations bigint NOT NULL DEFAULT 0
  CHECK (extraction_operations >= 0);

/* ── §11 The wipe, extended ──────────────────────────────────────────────── */

ALTER TABLE purge_receipts DROP CONSTRAINT purge_receipts_scope_check;
ALTER TABLE purge_receipts ADD CONSTRAINT purge_receipts_scope_check
  CHECK (scope IN ('entity', 'concept', 'silo', 'file', 'object'));

ALTER TABLE purge_receipts ADD COLUMN file_id uuid;
ALTER TABLE purge_receipts ADD COLUMN source_id uuid;
ALTER TABLE purge_receipts ADD COLUMN object_name text;
/* §11 — "Purging a file removes the file itself, not only the extracted rows."
   Both counted, so the receipt says which. */
ALTER TABLE purge_receipts ADD COLUMN files_removed integer NOT NULL DEFAULT 0 CHECK (files_removed >= 0);
ALTER TABLE purge_receipts ADD COLUMN rows_removed integer NOT NULL DEFAULT 0 CHECK (rows_removed >= 0);

ALTER TABLE purge_receipts DROP CONSTRAINT purge_receipts_scope_shape;
ALTER TABLE purge_receipts ADD CONSTRAINT purge_receipts_scope_shape CHECK (
     (scope = 'silo'    AND concept_id IS NULL     AND entity_ref IS NULL     AND file_id IS NULL     AND object_name IS NULL)
  OR (scope = 'concept' AND concept_id IS NOT NULL AND entity_ref IS NULL     AND file_id IS NULL     AND object_name IS NULL)
  OR (scope = 'entity'  AND concept_id IS NOT NULL AND entity_ref IS NOT NULL AND file_id IS NULL     AND object_name IS NULL)
  OR (scope = 'file'    AND file_id IS NOT NULL    AND concept_id IS NULL     AND entity_ref IS NULL  AND object_name IS NULL)
  OR (scope = 'object'  AND source_id IS NOT NULL  AND object_name IS NOT NULL AND concept_id IS NULL AND entity_ref IS NULL AND file_id IS NULL)
) NOT VALID;

/* ── §10 Permissions ─────────────────────────────────────────────────────── */

/*
 * SEPARATE FROM `silo.manage` because putting data in is a different act from
 * configuring what is kept. Held by Super admin and Admin, like `silo.manage`;
 * not scopeable, because what a Silo holds is organisation-wide.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('silo.import', 'silo', 'Upload files into a Silo or configure a watched location', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'silo.import'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
