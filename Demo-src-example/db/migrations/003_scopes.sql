-- 003_scopes — the tree an organisation defines for itself.
--
-- A SCOPE IS A GENERIC NODE AND THE ORGANISATION DECIDES WHAT ITS NODES MEAN.
-- Department, Project, Region, Team, Client, Matter — nothing is hard-coded, and
-- the type is a label rather than a structural rule. A Project under a Department
-- is legal; so is a Team under a Project. The tree is structural, the type is
-- descriptive, and conflating them produces a model that fits the first customer
-- and no others.
--
-- THE PATH IS MAINTAINED BY A TRIGGER, NOT BY THE APPLICATION. Every delegation
-- rule in the spec is expressed as subtree containment, so a path that disagrees
-- with the parent chain is a security failure rather than a data inconsistency —
-- an admin's authority is exactly the set of paths beneath theirs. Leaving it to
-- the application means one code path that forgets, and the resulting scope is
-- administered by nobody or by everybody.

-- ── Scope types ─────────────────────────────────────────────────────────────

CREATE TABLE scope_types (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  icon            text,
  colour          text        CHECK (colour IS NULL OR colour ~ '^#[0-9a-fA-F]{6}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, name)
);

-- ── Scopes ──────────────────────────────────────────────────────────────────

CREATE TABLE scopes (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  scope_type_id   uuid        NOT NULL REFERENCES scope_types(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  -- Null means top level. Only a super admin creates one of those.
  parent_id       uuid        REFERENCES scopes(id) ON DELETE RESTRICT,

  -- Maintained by the trigger below. Never written by the application.
  path            ltree       NOT NULL,
  depth           integer     NOT NULL,

  -- Archived, never deleted, while anything references it. A deleted scope takes
  -- its audit history and its grants with it.
  archived_at     timestamptz,

  created_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Two siblings may not share a name. Scoped to the parent, so `Platform` may
  -- exist under both Engineering and Operations.
  UNIQUE (organisation_id, parent_id, name),

  -- The cap from `constants.config`. Not a technical limit — ltree would take far
  -- more — but a guard against a runaway import creating a thousand-deep chain.
  CONSTRAINT scopes_depth_cap CHECK (depth BETWEEN 1 AND 12)
);

-- THE INDEX THAT MAKES THE WHOLE MODEL VIABLE. Every authorisation decision asks
-- "is this scope beneath that one", and GiST answers `@>` and `<@` as an index
-- lookup. Without it each check is a sequential scan of every scope in the
-- tenant, on every request.
CREATE INDEX scopes_path_gist ON scopes USING GIST (path);
CREATE INDEX scopes_by_org ON scopes (organisation_id) WHERE archived_at IS NULL;
CREATE INDEX scopes_by_parent ON scopes (parent_id) WHERE archived_at IS NULL;

-- ── Path maintenance ────────────────────────────────────────────────────────
--
-- The label is the uuid with dashes removed and an `s` prefix, matching
-- `utils/path.util.ts`. ltree labels may hold only letters, digits and
-- underscores and may not begin with a digit, so a raw uuid fails twice.

CREATE OR REPLACE FUNCTION scope_label(p_id uuid) RETURNS text
  LANGUAGE sql IMMUTABLE AS
$$ SELECT 's' || replace(p_id::text, '-', '') $$;

CREATE OR REPLACE FUNCTION scopes_maintain_path() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_path ltree;
  parent_org  uuid;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := scope_label(NEW.id)::ltree;
  ELSE
    SELECT path, organisation_id INTO parent_path, parent_org
      FROM scopes WHERE id = NEW.parent_id;

    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'Parent scope % does not exist', NEW.parent_id;
    END IF;

    /*
     * A PARENT IN ANOTHER TENANT WOULD BE A TREE SPANNING TWO ORGANISATIONS, and
     * every containment check would then hand one tenant's admin authority over
     * the other's scopes. Row level security stops the row being READ across
     * tenants; this stops it being LINKED across them.
     */
    IF parent_org <> NEW.organisation_id THEN
      RAISE EXCEPTION 'A scope cannot be parented in another organisation';
    END IF;

    /*
     * CYCLE PREVENTION. Moving a node beneath its own descendant does not create
     * a loop — it creates a DISCONNECTION: the rewritten paths no longer descend
     * from any root, so the subtree silently stops matching every containment
     * query. The scopes still exist and nobody administers them.
     */
    IF TG_OP = 'UPDATE' AND parent_path <@ OLD.path THEN
      RAISE EXCEPTION 'A scope cannot be moved beneath its own descendant';
    END IF;

    NEW.path := parent_path || scope_label(NEW.id)::ltree;
  END IF;

  NEW.depth := nlevel(NEW.path);
  RETURN NEW;
END $$;

CREATE TRIGGER scopes_path_before
  BEFORE INSERT OR UPDATE OF parent_id ON scopes
  FOR EACH ROW EXECUTE FUNCTION scopes_maintain_path();

/*
 * THE SUBTREE FOLLOWS THE NODE, IN THE SAME TRANSACTION.
 *
 * Moving a scope changes who administers everything beneath it. Rewriting the
 * descendants separately — or in the application, row by row — leaves a window in
 * which the tree is half-rewritten, and a half-rewritten tree is one where some
 * scopes are inside two admins' subtrees and others inside none.
 */
CREATE OR REPLACE FUNCTION scopes_rewrite_descendants() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.path IS DISTINCT FROM NEW.path THEN
    UPDATE scopes
       SET path  = NEW.path || subpath(path, nlevel(OLD.path)),
           depth = nlevel(NEW.path || subpath(path, nlevel(OLD.path)))
     WHERE path <@ OLD.path
       AND id <> NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER scopes_path_after
  AFTER UPDATE OF parent_id ON scopes
  FOR EACH ROW EXECUTE FUNCTION scopes_rewrite_descendants();

-- ── Scope membership ────────────────────────────────────────────────────────
--
-- MANY TO MANY. A person sits in Engineering, Project Falcon and Southern Region
-- at once, and their permissions are the union of what all three grant.
--
-- `is_primary` IS FOR DISPLAY AND DEFAULT ROUTING ONLY, NEVER FOR AUTHORISATION.
-- Using it to decide anything would make a display preference a security control,
-- and the first person to reorder their scopes would change what they can do.

CREATE TABLE scope_memberships (
  id            uuid        PRIMARY KEY,
  membership_id uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  scope_id      uuid        NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,

  is_primary    boolean     NOT NULL DEFAULT false,

  added_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  added_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (membership_id, scope_id)
);

CREATE INDEX scope_memberships_by_membership ON scope_memberships (membership_id);
CREATE INDEX scope_memberships_by_scope ON scope_memberships (scope_id);

-- At most one primary per membership. Partial, so the many non-primary rows are
-- unaffected.
CREATE UNIQUE INDEX scope_memberships_one_primary
  ON scope_memberships (membership_id) WHERE is_primary;

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE scope_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_types FORCE ROW LEVEL SECURITY;
ALTER TABLE scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE scope_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY scope_types_tenant ON scope_types
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

CREATE POLICY scopes_tenant ON scopes
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/*
 * `scope_memberships` HAS NO `organisation_id` OF ITS OWN, so its policy reaches
 * through the scope. Denormalising the column would be faster and would create a
 * second source of truth for which tenant a row belongs to — and the two would
 * disagree the first time a scope moved.
 */
CREATE POLICY scope_memberships_tenant ON scope_memberships
  USING (EXISTS (SELECT 1 FROM scopes s WHERE s.id = scope_id AND s.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM scopes s WHERE s.id = scope_id AND s.organisation_id = app_org_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON scope_types, scopes, scope_memberships TO silo_app;
GRANT EXECUTE ON FUNCTION scope_label(uuid) TO silo_app;
