-- 004_authz — the two independent gates.
--
-- BOTH MUST PASS AND NEITHER OVERRIDES THE OTHER. Discretionary access is what
-- roles grant; mandatory access is what clearances permit. Deny wins in both, and
-- the combining rule is the part that gets written backwards:
--
--   Discretionary   UNION across every scope a membership belongs to.
--   Mandatory       INTERSECT. One missing marking denies, whatever the roles say.
--
-- A person in two scopes gets the sum of what both permit and is still blocked by
-- any marking either lacks. Reversing either half is the classic hole in a
-- combined RBAC and MAC system.

-- ── The permission catalogue ────────────────────────────────────────────────
--
-- FIXED, SEEDED HERE, NOT USER-CREATABLE. A customer inventing a permission
-- means the application has to decide what it protects, which it cannot — so
-- there would be a permission nothing checks, granted to people who then believe
-- they are restricted.
--
-- NO `organisation_id`, AND THEREFORE NO RLS. The catalogue is identical for
-- every tenant; it is reference data, like a currency list.

CREATE TABLE permissions (
  id          text        PRIMARY KEY,
  category    text        NOT NULL,
  description text        NOT NULL,
  -- Whether it can be granted against a scope, or only organisation-wide.
  -- `billing.manage` is meaningless on a subtree; `query.compile` is not.
  scopeable   boolean     NOT NULL DEFAULT true
);

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('query.compile',        'query',      'Ask a question and have it compiled',                  true),
  ('query.run',            'query',      'Run a saved view',                                     true),
  ('mutation.propose',     'mutation',   'Propose a change to a connected system',               true),
  ('mutation.approve',     'mutation',   'Approve a proposed change',                            true),
  ('connection.create',    'connection', 'Create a connection to a system',                      true),
  ('connection.grant',     'connection', 'Give others access to a connection you hold',          true),
  ('silo.enable',          'silo',       'Create a Silo and choose what it stores',              true),
  ('view.share',           'view',       'Share a saved view',                                   true),
  ('member.invite',        'member',     'Invite somebody to the organisation',                  true),
  ('member.suspend',       'member',     'Suspend or reinstate a member',                        true),
  ('member.remove',        'member',     'Remove a member',                                      true),
  ('scope.create',         'scope',      'Create a scope beneath one you administer',            true),
  ('scope.move',           'scope',      'Move a scope within your subtree',                     true),
  ('scope.archive',        'scope',      'Archive a scope',                                      true),
  ('scope.assign',         'scope',      'Put a member into a scope',                            true),
  ('role.grant',           'role',       'Assign a role you are whitelisted to assign',          true),
  ('seat.allocate',        'seat',       'Allocate seats from a pool you hold',                  true),
  -- The three that are organisation-wide by nature.
  ('clearance.grant',      'clearance',  'Grant a clearance. Super admin only, never delegable', false),
  ('billing.manage',       'billing',    'Manage the subscription and payment details',          false),
  ('seat.release',         'seat',       'Reduce the licence count. Distinct from offboarding',  false),
  ('tokens.purchase',      'billing',    'Buy tokens or simulations',                            false),
  ('org.logo.manage',      'org',        'Change the organisation logo',                         false),
  ('org.sharing.manage',   'org',        'Set the view sharing policy',                          false),
  ('sso.manage',           'org',        'Configure the identity provider',                      false),
  ('audit.read',           'audit',      'Read the audit trail',                                 true);

-- ── Roles ───────────────────────────────────────────────────────────────────

CREATE TABLE roles (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  description     text,
  -- A system role is created with the organisation and may not be deleted. The
  -- super admin role in particular: an organisation that deletes it has nobody
  -- who can create another.
  system_role     boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, name)
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id text NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_id)
);

-- `CASCADE` here and nowhere else: a role's permission list is part of the role,
-- not a historical fact about it. Deleting the role should take it.

-- ── Which roles a role may hand out ─────────────────────────────────────────
--
-- HOLDING A PERMISSION IS NOT THE SAME AS BEING ALLOWED TO GIVE IT AWAY. An
-- admin with `member.invite` can invite; whether they can make somebody else an
-- admin is a separate decision, and without this table the answer is "anyone who
-- holds a permission can propagate it", which is unbounded delegation.

CREATE TABLE role_grantable_roles (
  granting_role_id  uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  grantable_role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (granting_role_id, grantable_role_id),
  -- A role granting itself is legal and useful: an admin appointing another
  -- admin beneath them is the whole delegation model.
  CHECK (true)
);

-- ── Assignments ─────────────────────────────────────────────────────────────
--
-- THE PROVENANCE COLUMNS ARE WHAT MAKE THIS AUDITABLE AFTER A RESTRUCTURE.
-- `granted_at_scope_id` records the scope the GRANTER was acting under at the
-- time. Without it, a later change to the tree makes it impossible to establish
-- whether a grant was valid when it was issued — the admin's subtree has moved,
-- and the only evidence of what it contained is gone.

CREATE TABLE role_assignments (
  id                  uuid        PRIMARY KEY,
  membership_id       uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  role_id             uuid        NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,

  -- What the assignment is scoped to. `null` scope_type means organisation-wide,
  -- which is a super admin and may only be created by one.
  scope_type          text        CHECK (scope_type IN ('scope', 'connection', 'silo', 'view')),
  scope_id            uuid,

  granted_by          uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  granted_at_scope_id uuid        REFERENCES scopes(id) ON DELETE RESTRICT,

  granted_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  revoked_by          uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  revoked_at          timestamptz,

  -- A scope type without an id, or an id without a type, is a grant nobody can
  -- resolve.
  CONSTRAINT role_assignments_scope_pair
    CHECK ((scope_type IS NULL) = (scope_id IS NULL))
);

CREATE INDEX role_assignments_by_membership ON role_assignments (membership_id)
  WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_by_scope ON role_assignments (scope_id)
  WHERE revoked_at IS NULL AND scope_id IS NOT NULL;
CREATE INDEX role_assignments_by_granter ON role_assignments (granted_by);

-- One live assignment of a role to a membership at a scope. Partial, so the same
-- role can be re-granted after revocation and the history survives.
CREATE UNIQUE INDEX role_assignments_one_live
  ON role_assignments (membership_id, role_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;

-- ── The mandatory gate ──────────────────────────────────────────────────────

CREATE TABLE markings (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  -- A classification is a level (Confidential, Secret). A compartment is a
  -- need-to-know set (ORION). They behave identically here — hold it or you do
  -- not — and are distinguished so an interface can present them differently.
  kind            text        NOT NULL CHECK (kind IN ('classification', 'compartment')),
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, name)
);

CREATE TABLE clearances (
  id            uuid        PRIMARY KEY,
  membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  marking_id    uuid        NOT NULL REFERENCES markings(id) ON DELETE RESTRICT,

  granted_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,

  UNIQUE (membership_id, marking_id)
);

CREATE INDEX clearances_by_membership ON clearances (membership_id) WHERE revoked_at IS NULL;

CREATE TABLE resource_markings (
  id            uuid        PRIMARY KEY,
  resource_type text        NOT NULL CHECK (resource_type IN ('connection', 'field', 'concept', 'silo', 'view')),
  resource_id   text        NOT NULL,
  marking_id    uuid        NOT NULL REFERENCES markings(id) ON DELETE RESTRICT,

  UNIQUE (resource_type, resource_id, marking_id)
);

CREATE INDEX resource_markings_lookup ON resource_markings (resource_type, resource_id);

/*
 * CONCEPT MARKINGS CLOSE A SIDE CHANNEL THAT FIELD MARKINGS LEAVE OPEN.
 *
 * An ontology concept resolves an entity across systems. If one contributing
 * system is restricted and another is not, resolving the concept reveals that a
 * restricted record EXISTS — the count changes, the join succeeds, the entity
 * appears — without any restricted field ever being returned.
 *
 * The compiler drops the concept from the plan entirely rather than resolving it
 * and filtering afterwards, so resolution never runs against a source the user
 * cannot see.
 */
CREATE TABLE concept_markings (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      text        NOT NULL,
  marking_id      uuid        NOT NULL REFERENCES markings(id) ON DELETE RESTRICT,

  UNIQUE (organisation_id, concept_id, marking_id)
);

-- ── Row level security ──────────────────────────────────────────────────────
--
-- `permissions` IS THE ONE TABLE HERE WITHOUT A POLICY, because it has no tenant:
-- the catalogue is identical everywhere and holds nothing about anybody.

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE role_grantable_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_grantable_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE markings ENABLE ROW LEVEL SECURITY;
ALTER TABLE markings FORCE ROW LEVEL SECURITY;
ALTER TABLE clearances ENABLE ROW LEVEL SECURITY;
ALTER TABLE clearances FORCE ROW LEVEL SECURITY;
ALTER TABLE resource_markings ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_markings FORCE ROW LEVEL SECURITY;
ALTER TABLE concept_markings ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_markings FORCE ROW LEVEL SECURITY;

CREATE POLICY roles_tenant ON roles
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

CREATE POLICY markings_tenant ON markings
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

CREATE POLICY concept_markings_tenant ON concept_markings
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

-- The join tables reach through to their parent rather than denormalising a
-- tenant column, for the same reason `scope_memberships` does: two sources of
-- truth for which tenant a row belongs to will eventually disagree.
CREATE POLICY role_permissions_tenant ON role_permissions
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.organisation_id = app_org_id()));

CREATE POLICY role_grantable_tenant ON role_grantable_roles
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = granting_role_id AND r.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = granting_role_id AND r.organisation_id = app_org_id()));

CREATE POLICY role_assignments_tenant ON role_assignments
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND m.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND m.organisation_id = app_org_id()));

CREATE POLICY clearances_tenant ON clearances
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND m.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_id AND m.organisation_id = app_org_id()));

CREATE POLICY resource_markings_tenant ON resource_markings
  USING (EXISTS (SELECT 1 FROM markings mk WHERE mk.id = marking_id AND mk.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM markings mk WHERE mk.id = marking_id AND mk.organisation_id = app_org_id()));

GRANT SELECT ON permissions TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  roles, role_permissions, role_grantable_roles, role_assignments,
  markings, clearances, resource_markings, concept_markings
TO silo_app;
