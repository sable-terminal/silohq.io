/*
 * 092 — a document somebody produced, and the permissions that shaped it.
 *
 * ── §1: "An export is a frozen result" ─────────────────────────────────────
 *
 * "A person made it, under their permissions, at a moment in time. It is not a
 * cached view and it does not track one." So this table holds no reference back
 * to a live question that could change underneath it — the link to the view is
 * provenance, recorded for tracing, and deleting the view leaves the file
 * standing.
 *
 * ── §10: exports first, and uploads have nowhere to live yet ───────────────
 *
 * `silo_id` is here and nullable because §8 says a file carries one and §5 says
 * uploads require it. Nothing writes it in this migration: the upload path
 * arrives in step 3, and a column that exists before the code that fills it is
 * cheaper than a migration that widens a table people have already got data in.
 *
 * `folder_id` is nullable for the same reason — folders are step 2, and §2 says
 * a folder "carries no permissions of its own", so a file with no folder is
 * fully governed already.
 */

CREATE TABLE files (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §1 — the two things Files holds. */
  kind              text        NOT NULL CHECK (kind IN ('export', 'upload')),

  name              text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 256),

  /* Where the bytes are. The object store's key, never a path a caller chose. */
  object_key        text        NOT NULL CHECK (length(trim(object_key)) BETWEEN 1 AND 1024),
  content_type      text        NOT NULL,
  bytes             bigint      NOT NULL CHECK (bytes >= 0),

  /* §5 — required for an upload, absent on an export. Enforced when uploads
     arrive; the CHECK below already refuses an upload without one. */
  silo_id           uuid        REFERENCES siloes(id) ON DELETE RESTRICT,

  folder_id         uuid,

  created_by        uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),

  /*
   * §6 — "Exports have their own retention, set per organisation, defaulting to
   * indefinite. They are not Silo data and are not governed by a Silo's window."
   * Null is indefinite, and it is the default for exactly that reason.
   */
  expires_at        timestamptz,

  deleted_at        timestamptz,

  /* §5 — "Every upload requires a Silo." Said here so it cannot be forgotten by
     whichever service writes the row. */
  CONSTRAINT files_upload_has_silo CHECK (kind <> 'upload' OR silo_id IS NOT NULL),
  CONSTRAINT files_export_has_no_silo CHECK (kind <> 'export' OR silo_id IS NULL)
);

CREATE INDEX files_by_owner ON files (created_by, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX files_by_folder ON files (folder_id) WHERE deleted_at IS NULL;
CREATE INDEX files_expiring ON files (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

/*
 * §3 — "Permissions are inherited at creation and frozen."
 *
 * ── WHY A SNAPSHOT AND NOT A JOIN ──────────────────────────────────────────
 *
 * "Sharing the view more widely does not widen the file. Narrowing the view
 * does not narrow it. The export was a decision someone made, and it stands on
 * its own terms." A join to live clearances and policies would do the opposite
 * of all three: the file would silently change shape every time somebody's
 * grants moved, and a document produced in March would not be the document
 * anybody remembers producing.
 *
 * ── WHAT IS STORED IS WHAT APPLIED, NOT WHAT WAS SEEN ─────────────────────
 *
 * The marking ids the exporter held, the field paths that were hidden from
 * them, and the connections they could reach. No value from the result: the
 * bytes are in the object store, and a second copy of a customer's data in the
 * control plane is the thing this architecture keeps saying it does not keep.
 */
CREATE TABLE file_permissions (
  file_id           uuid        PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* Marking ids the exporting person held clearance for at that moment. */
  clearances        uuid[]      NOT NULL DEFAULT '{}',
  /* Field paths a policy hid from them. §3's "the file says a field was
     omitted rather than showing a gap" is rendered from this. */
  omitted_fields    text[]      NOT NULL DEFAULT '{}',
  /* Connections they could reach. */
  connections       uuid[]      NOT NULL DEFAULT '{}',

  frozen_at         timestamptz NOT NULL DEFAULT now()
);

/*
 * §3 — "The file records its provenance: which view, which run, when, and by
 * whom. Enough to trace where a figure came from, whether or not the view still
 * exists."
 *
 * NO FOREIGN KEY TO THE SOURCE, DELIBERATELY. §6 — "Retained after the source
 * is deleted." A reference that cascaded would erase the answer to "where did
 * this figure come from" at exactly the moment somebody asks it, and one that
 * restricted would stop people deleting their own views.
 */
CREATE TABLE file_provenance (
  file_id           uuid        PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §3 — "Produced from a view, a finding, a ranking or a receipt." */
  source_kind       text        NOT NULL CHECK (source_kind IN ('view', 'finding', 'ranking', 'receipt')),
  source_id         uuid        NOT NULL,
  /* The name the source had when it was exported, because it may be gone. */
  source_name       text,

  /* Which execution of it, where the source has runs. */
  run_reference     text,

  produced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX file_provenance_by_source ON file_provenance (source_kind, source_id);

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE  ROW LEVEL SECURITY;
CREATE POLICY files_tenant ON files
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE file_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_permissions FORCE  ROW LEVEL SECURITY;
CREATE POLICY file_permissions_tenant ON file_permissions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE file_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_provenance FORCE  ROW LEVEL SECURITY;
CREATE POLICY file_provenance_tenant ON file_provenance
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON files TO silo_app;
GRANT SELECT, INSERT ON file_permissions TO silo_app;
GRANT SELECT, INSERT ON file_provenance TO silo_app;

/*
 * §7 — `file.export`. The rest of the table arrives with the code that
 * enforces it: a permission catalogued before its enforcement exists is a
 * grant somebody can hold and nothing can check.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('file.export', 'file', 'Produce an export from a view, finding, ranking or receipt', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'file.export'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin', 'Member')
ON CONFLICT DO NOTHING;
