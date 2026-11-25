/*
 * 093 — an arrangement, and who else may open a document.
 *
 * ── §2: "A folder carries no permissions of its own" ───────────────────────
 *
 * "It is an arrangement, not a boundary. Every access decision is made on the
 * file, because a folder that grants access would let someone widen a file's
 * reach by moving it."
 *
 * So this table has no grantee column, no access column and no share table of
 * its own. That absence is the design: the only way to make a folder into a
 * boundary later is to add a column here, and anybody doing so has to read this
 * comment first.
 *
 * ── §2: a folder does not say how many files it holds ──────────────────────
 *
 * "A folder shows only what the viewer may see... and the folder does not state
 * how many files it holds, since a count is a disclosure." There is therefore
 * no counter column and no materialised total. A number that says "47 files"
 * to somebody who may see three tells them about the other forty-four.
 */

CREATE TABLE folders (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /* An ordinary tree. Null is the root. */
  parent_id       uuid        REFERENCES folders(id) ON DELETE RESTRICT,

  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT folders_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),

  /* Two folders with one name under one parent is a tree nobody can navigate. */
  UNIQUE (organisation_id, parent_id, name)
);

CREATE INDEX folders_by_parent ON folders (parent_id);

ALTER TABLE files
  ADD CONSTRAINT files_folder_fkey FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE RESTRICT;

/*
 * §4 — "Same model as views and maps. Private by default, shareable with a
 * membership, a scope or the organisation, subject to the organisation's
 * sharing policy."
 *
 * MODELLED ON `map_shares`, including the one-grantee constraint: a share
 * addressed to two things is one whose meaning depends on which column
 * somebody read first.
 *
 * ── §4: "Sharing a view does not share its exports" ───────────────────────
 *
 * Which is why this is its own table rather than a flag on a view's share.
 * They are separate objects with separate shares, and a join that derived one
 * from the other would make widening a view quietly widen every document ever
 * produced from it — the exact thing §3 says an export does not do.
 */
CREATE TABLE file_shares (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  file_id           uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,

  membership_id     uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  scope_id          uuid        REFERENCES scopes(id) ON DELETE RESTRICT,
  organisation_wide boolean     NOT NULL DEFAULT false,

  CONSTRAINT file_shares_one_grantee CHECK (
    (membership_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int + (organisation_wide)::int = 1
  ),

  /*
   * `view` OR `download`, AND NOT `edit`. A file is a frozen result (§1);
   * there is nothing in it to edit, and a share that implied otherwise would
   * be offering something the object cannot do.
   */
  access            text        NOT NULL CHECK (access IN ('view', 'download')),

  shared_by         uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  shared_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,

  CONSTRAINT file_shares_unique_grantee UNIQUE (file_id, membership_id, scope_id, organisation_wide)
);

CREATE INDEX file_shares_live ON file_shares (file_id) WHERE revoked_at IS NULL;
CREATE INDEX file_shares_by_membership ON file_shares (membership_id) WHERE revoked_at IS NULL;

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE  ROW LEVEL SECURITY;
CREATE POLICY folders_tenant ON folders
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE file_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_shares FORCE  ROW LEVEL SECURITY;
CREATE POLICY file_shares_tenant ON file_shares
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON folders TO silo_app;
GRANT SELECT, INSERT, UPDATE ON file_shares TO silo_app;

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('file.share', 'file', 'Share a file within the organisation', false),
  ('file.manage', 'file', 'Move, rename and organise folders', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN (VALUES ('file.share'), ('file.manage')) AS p(id)
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin', 'Member')
ON CONFLICT DO NOTHING;
