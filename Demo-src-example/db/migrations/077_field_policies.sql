/*
 * 077 — field policies: which fields of a connection a membership may see.
 *
 * ── Declared since the beginning, held nowhere ─────────────────────────────
 *
 * `effectivePermissions.util` has resolved field policies since the
 * authorisation model was written — deny beats mask beats redact, targeted by
 * role, marking or scope — and nothing ever called it, because there was no
 * table to read and no compiler to enforce it in. `connector.service` said so:
 * "until it lands, a shared credential with broad rights is exactly the hole it
 * looks like."
 *
 * ── Enforced before the query exists ───────────────────────────────────────
 *
 * Mutations §3: "A field the user cannot see cannot be written, because it
 * never enters the manifest." The same holds for reading. A hidden field is
 * taken out of the vocabulary a compiler is given and out of every query before
 * it is sent, never filtered out of an answer afterwards.
 *
 * `field_path` IS THE CONNECTION'S OWN FIELD NAME. A policy is about a system's
 * field, whatever concept later maps it, so a concept added next month cannot
 * route round it by calling the field something else.
 */

CREATE TABLE field_policies (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id       uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  field_path          text        NOT NULL CHECK (length(field_path) BETWEEN 1 AND 256),
  effect              text        NOT NULL CHECK (effect IN ('deny', 'mask', 'redact')),
  applies_to_role     uuid        REFERENCES roles(id) ON DELETE RESTRICT,
  applies_to_marking  uuid        REFERENCES markings(id) ON DELETE RESTRICT,
  applies_to_scope    uuid        REFERENCES scopes(id) ON DELETE RESTRICT,
  include_descendants boolean     NOT NULL DEFAULT true,
  created_by          uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_by          uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  revoked_at          timestamptz,
  CONSTRAINT field_policies_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX field_policies_live ON field_policies (organisation_id, connection_id) WHERE revoked_at IS NULL;

ALTER TABLE field_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_policies FORCE  ROW LEVEL SECURITY;
CREATE POLICY field_policies_tenant ON field_policies
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* Revoked, never deleted: which fields were hidden from whom, and when, is evidence. */
GRANT SELECT, INSERT, UPDATE ON field_policies TO silo_app;

/*
 * SUPER ADMIN, NOT SCOPEABLE. A policy targets any scope, role or marking in the
 * organisation, so setting one is an organisation-wide act; a scope admin who
 * could hide a field from the scope above them would not be administering their
 * own part of the tree.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('field_policy.manage', 'policy', 'Decide which fields of a connection each person may see', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'field_policy.manage'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
