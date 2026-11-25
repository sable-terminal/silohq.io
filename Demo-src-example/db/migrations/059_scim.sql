/*
 * §1 — SCIM. Accounts that exist before somebody signs in, and stop when they
 * leave.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * SSO answers "is this really them". It says nothing about the lifecycle around
 * that: somebody joins and cannot sign in until an administrator remembers to
 * add them, and somebody LEAVES and keeps their access until an administrator
 * remembers to remove them. The second one is the problem — an offboarding that
 * depends on a person remembering every tool is a standard audit finding, and
 * it is why an enterprise will not buy without this.
 *
 * The identity provider is the client and we are the server. It posts a create
 * when HR adds somebody, and a deactivate when they go.
 *
 * ── The boundary this schema exists to hold ────────────────────────────────
 *
 * A DIRECTORY GROUP MUST NOT BE ABLE TO GRANT AUTHORITY. Silo has six
 * delegation rules, checked before any grant is written, and they are checked
 * against a GRANTER — a membership with a scope, the permissions it effectively
 * holds there, and a whitelist of roles it may hand out. An identity provider
 * is not a membership and has no granter, so a group that could assign a role
 * directly would be a path around all six: whoever administers the directory
 * could make themselves a super admin in Silo without anybody in Silo agreeing.
 *
 * SO THE MAPPING IS THE DELEGATED ACT, NOT THE MEMBERSHIP CHANGE. An
 * administrator declares once that a named directory group carries a role at a
 * scope, and `checkDelegation` runs THEN, against them. After that the provider
 * only moves people in and out of an envelope somebody was already allowed to
 * create. Every role a person holds still traces to a human who could grant it,
 * and `granted_by` still names them.
 */

/* ── The credential the provider authenticates with ────────────────────── */

/*
 * A BEARER TOKEN, HASHED, exactly like an API key and a session. The customer
 * generates it here and pastes it into their provider; the plaintext exists in
 * one response and is never recoverable. `last_four` is the only fragment kept,
 * so somebody with two configured can tell which is which.
 */
CREATE TABLE scim_tokens (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  token_hash      text        NOT NULL UNIQUE,
  last_four       text        NOT NULL CHECK (length(last_four) = 4),

  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  /* Support answers "is the sync running" without reading anybody's data. */
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

CREATE INDEX scim_tokens_by_org ON scim_tokens (organisation_id) WHERE revoked_at IS NULL;

ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY scim_tokens_tenant ON scim_tokens
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON scim_tokens TO silo_app;

/*
 * THE LOOKUP RUNS BEFORE A TENANT IS KNOWN, which is the whole difficulty of an
 * inbound credential: the token is what SAYS which organisation this is, so the
 * read that finds it cannot already be inside one. `SECURITY DEFINER` and a
 * hash-only argument, exactly as the SSO sign-in reads do — it can answer "which
 * organisation owns this hash" and nothing else.
 */
CREATE OR REPLACE FUNCTION scim_token_owner(p_token_hash text)
RETURNS TABLE (token_id uuid, organisation_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$
  SELECT id, organisation_id
    FROM scim_tokens
   WHERE token_hash = p_token_hash AND revoked_at IS NULL
$$;

GRANT EXECUTE ON FUNCTION scim_token_owner(text) TO silo_app;

/* ── What the directory says ────────────────────────────────────────────── */

/*
 * A group as the provider states it. `external_id` is the provider's own id,
 * stable across renames — the display name is not, and keying on it would make
 * a rename in the directory look like a different group entirely.
 */
CREATE TABLE scim_groups (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  external_id     text        NOT NULL,
  display_name    text        NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 256),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scim_groups_unique UNIQUE (organisation_id, external_id)
);

ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_groups FORCE  ROW LEVEL SECURITY;

CREATE POLICY scim_groups_tenant ON scim_groups
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups TO silo_app;

/* Who the directory says is in it. */
CREATE TABLE scim_group_members (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  group_id        uuid        NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,

  added_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scim_group_members_unique UNIQUE (group_id, membership_id)
);

CREATE INDEX scim_group_members_by_membership ON scim_group_members (membership_id);

ALTER TABLE scim_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_group_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY scim_group_members_tenant ON scim_group_members
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_group_members TO silo_app;

/* ── The envelope an administrator authorised ───────────────────────────── */

/*
 * WHAT A DIRECTORY GROUP CARRIES, DECLARED BY SOMEBODY WHO COULD GRANT IT.
 *
 * This is the row `checkDelegation` is run against, ONCE, at the moment it is
 * written — not on every membership change, because a provider pushing a
 * thousand members must not be able to make a thousand authority decisions.
 *
 * `declared_by` IS THE GRANTER OF EVERY ASSIGNMENT THIS PRODUCES, so the chain
 * from a person's role back to a human who was allowed to grant it stays
 * unbroken. A directory never appears in it.
 *
 * BOTH HALVES ARE OPTIONAL AND AT LEAST ONE IS REQUIRED. A group may place
 * people in a scope without granting anything — which is the common and safe
 * case — or carry a role, or both.
 */
CREATE TABLE scim_group_grants (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  group_id        uuid        NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,

  /** Where members of this group sit. */
  scope_id        uuid        REFERENCES scopes(id) ON DELETE CASCADE,
  /** What they may do there. NULL means placement only. */
  role_id         uuid        REFERENCES roles(id) ON DELETE RESTRICT,

  CONSTRAINT scim_group_grants_carries_something
    CHECK (scope_id IS NOT NULL OR role_id IS NOT NULL),

  /*
   * A ROLE WITHOUT A SCOPE IS AN ORGANISATION-WIDE GRANT — a super admin — and
   * that is never something a directory group may confer. The delegation rules
   * say so for a person; saying it again here means a repository that forgets
   * to call them cannot write the row either.
   */
  CONSTRAINT scim_group_grants_role_is_scoped
    CHECK (role_id IS NULL OR scope_id IS NOT NULL),

  declared_by     uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  declared_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scim_group_grants_unique UNIQUE (group_id, scope_id, role_id)
);

CREATE INDEX scim_group_grants_by_group ON scim_group_grants (group_id);

ALTER TABLE scim_group_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_group_grants FORCE  ROW LEVEL SECURITY;

CREATE POLICY scim_group_grants_tenant ON scim_group_grants
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_group_grants TO silo_app;

/*
 * ── Provisioned, so deprovisioning knows what it may touch ───────────────
 *
 * A membership the directory created is one the directory may deactivate. One a
 * person created by hand is NOT: a provider that starts syncing an existing
 * organisation must not be able to suspend the founder because they happen not
 * to be in its directory.
 */
ALTER TABLE memberships
  ADD COLUMN provisioned_by_scim boolean NOT NULL DEFAULT false;
