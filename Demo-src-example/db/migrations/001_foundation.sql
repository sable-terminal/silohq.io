-- 001_foundation — extensions, roles, and the three tables everything hangs off.
--
-- THE WHOLE SECURITY MODEL RESTS ON WHO IS CONNECTED. Two roles, and the
-- difference between them is the difference between a bug that returns nothing
-- and a bug that returns every tenant's data:
--
--   silo_app        the application. NOBYPASSRLS. Row level security applies to
--                   it, so a query that forgets its tenant predicate returns an
--                   empty set rather than the whole table.
--   silo_migrator   migrations only. Owns the tables, holds the bypass, and its
--                   credentials are never given to the server.
--
-- The roles are created by `db:provision`, outside the migration ledger, because a
-- role is a cluster-level object and a migration that creates one cannot be run
-- twice against the same cluster by two databases. This file only grants.
--
-- RLS IS ENABLED *AND* FORCED. `ENABLE` alone exempts the table owner, and the
-- owner is `silo_migrator` — which is fine, but it means a test connecting as the
-- owner proves nothing. `FORCE` applies the policies to the owner too, so the
-- isolation test tests the thing that is actually deployed.

-- THE EXTENSIONS ARE NOT CREATED HERE. `CREATE EXTENSION` requires superuser on
-- a stock Postgres and `silo_migrator` is not one — but on Cloud SQL it would
-- have succeeded, so this migration would have passed in production and failed
-- on every developer machine. `db:provision` creates them as the cluster owner,
-- which behaves the same in both places. This only checks, so a database that
-- skipped provisioning fails here with a sentence rather than on the first
-- `citext` column with a type error.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(e, ', ') INTO missing
  FROM unnest(ARRAY['citext', 'pgcrypto', 'ltree']) AS e
  WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = e);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Missing extensions: %. Run `npm run db:provision` first.', missing;
  END IF;
END $$;

-- ── Tenant context ──────────────────────────────────────────────────────────
--
-- Every policy reads these. They are set per transaction with `set local`, which
-- is not a style preference: `set` persists on the connection, and a pooled
-- connection carrying one tenant's id into the next request is the single most
-- likely way this system leaks. `set local` is discarded at COMMIT, so the worst
-- case is a missing context rather than somebody else's.
--
-- `current_setting(..., true)` returns NULL rather than raising when the variable
-- is unset, so an unconfigured connection matches no rows instead of erroring
-- into a code path somebody might be tempted to catch and continue from.

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_membership_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.membership_id', true), '')::uuid $$;

-- THE ONE PIECE OF CONTEXT THAT EXISTS BEFORE A TENANT DOES.
--
-- Login has an email and nothing else. It finds the user, verifies the password,
-- and then has to ask which organisations that person belongs to so they can
-- choose one — and `memberships` is under a policy keyed on `app.org_id`, which
-- at that moment is unknown. Without this the answer is always zero rows and
-- there is no path from a correct password to a session.
--
-- It is set only after the password has been verified. Before that there is no
-- authenticated identity and nothing should be readable.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ── Organisations ───────────────────────────────────────────────────────────

CREATE TABLE organisations (
  id                  uuid        PRIMARY KEY,
  name                text        NOT NULL CHECK (length(trim(name)) > 0),
  -- citext, so `Acme` and `acme` cannot both be registered. A case-sensitive
  -- unique index on a slug that appears in URLs is a phishing surface.
  --
  -- `slug::text` IN THE CHECK, AND THE CAST IS THE WHOLE POINT. citext overloads
  -- the regex operators to be case-insensitive, so `slug ~ '^[a-z0-9]...'`
  -- happily accepts `Acme-Ltd` — the constraint reads as lowercase-only and
  -- enforces nothing. Verified: `'Acme-Ltd'::citext ~ '^[a-z0-9]...'` is true and
  -- the `::text` form is false. Casting compares as text, which is what was
  -- meant, while the column stays citext so uniqueness remains case-insensitive.
  slug                citext      NOT NULL UNIQUE
                                  CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),

  plan                text        NOT NULL DEFAULT 'standard'
                                  CHECK (plan IN ('standard', 'business', 'enterprise')),
  sso_required        boolean     NOT NULL DEFAULT false,
  mfa_required        boolean     NOT NULL DEFAULT false,
  -- The Siloes master switch. Off means no storage anywhere in the tenant,
  -- whatever an individual Silo says.
  storage_enabled     boolean     NOT NULL DEFAULT false,

  logo_object_key     text,
  logo_content_type   text,
  -- Constrained below, once `memberships` exists. The two tables reference each
  -- other, so one direction has to be added afterwards.
  logo_uploaded_by    uuid,
  logo_uploaded_at    timestamptz,

  billing_status      text        NOT NULL DEFAULT 'active'
                                  CHECK (billing_status IN ('active', 'past_due', 'suspended', 'cancelled')),

  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ── Users ───────────────────────────────────────────────────────────────────
--
-- NOT UNDER RLS, DELIBERATELY, and this is the one place the rule is relaxed.
-- A user is global: one person with one password may belong to organisations in
-- different tenants, so there is no `organisation_id` to write a policy against.
-- Reaching a user requires going through `memberships`, which IS under RLS, so
-- the join is what constrains it. Nothing here is tenant data — a name, an email
-- and a password hash.

CREATE TABLE users (
  id                    uuid        PRIMARY KEY,
  first_name            text        NOT NULL CHECK (length(trim(first_name)) > 0),
  last_name             text        NOT NULL CHECK (length(trim(last_name)) > 0),
  email                 citext      NOT NULL UNIQUE,
  email_verified_at     timestamptz,

  -- Nullable, because an SSO-only membership never sets one. A row with no hash
  -- can never be authenticated by password: the verifier has nothing to compare
  -- against and must not treat that as a match.
  password_hash         text,
  password_changed_at   timestamptz,

  failed_attempt_count  integer     NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
  locked_until          timestamptz,

  avatar_object_key     text,
  avatar_content_type   text,

  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'suspended', 'deprovisioned')),

  created_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz
);

-- ── Memberships ─────────────────────────────────────────────────────────────
--
-- THE BINDING RULE. Every authorisation decision, every audit row and every
-- owned resource references `membership_id`, never `user_id`. A user in three
-- organisations has three memberships and no permission crosses between them.
-- Writing a permission against a user id would make the tenant boundary a
-- convention rather than a constraint.

CREATE TABLE memberships (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  status          text        NOT NULL DEFAULT 'invited'
                              CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  job_title       text,

  invited_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  invited_at      timestamptz,
  joined_at       timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, organisation_id)
);

-- `RESTRICT` everywhere above, never `CASCADE`. Removal is a status change; the
-- foreign keys exist to make deletion fail loudly rather than to make it tidy.
-- An audit trail that can be destroyed by deleting a member is not an audit
-- trail.

-- The circular half of the pair. `organisations.logo_uploaded_by` was a bare
-- uuid, which is a foreign key that does not check anything: it could hold an
-- id from another tenant, or one that never existed. Added here because
-- `memberships` did not exist when the column was declared.
ALTER TABLE organisations
  ADD CONSTRAINT organisations_logo_uploaded_by_fkey
  FOREIGN KEY (logo_uploaded_by) REFERENCES memberships(id) ON DELETE RESTRICT;

CREATE INDEX memberships_by_org ON memberships (organisation_id, status);
CREATE INDEX memberships_by_user ON memberships (user_id) WHERE status = 'active';

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships   FORCE ROW LEVEL SECURITY;

-- `USING` governs which rows are visible; `WITH CHECK` governs which may be
-- written. Both are required. A policy with only `USING` lets a caller INSERT a
-- row belonging to another tenant, which they then cannot see — data written
-- across a boundary they could not read across.

CREATE POLICY organisations_tenant ON organisations
  USING (id = app_org_id())
  WITH CHECK (id = app_org_id());

CREATE POLICY memberships_tenant ON memberships
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

-- A person may see their OWN memberships without a tenant context, and only
-- their own. This is what makes the organisation picker at login possible.
--
-- `FOR SELECT`, deliberately. Policies are permissive and OR together, so a
-- policy without a command restriction would also grant INSERT and UPDATE —
-- letting somebody create a membership for themselves in any organisation they
-- can name, which is self-service tenant access.
--
-- It is still default-deny: `app.user_id` is set only after a password has been
-- verified, and it can only ever match rows belonging to that person.
CREATE POLICY memberships_own ON memberships
  FOR SELECT
  USING (user_id = app_user_id());

-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- The application gets DML and nothing else. No DDL, no TRUNCATE. It cannot drop
-- a table it can be tricked into dropping.

GRANT USAGE ON SCHEMA public TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organisations, memberships TO silo_app;
GRANT SELECT, INSERT, UPDATE ON users TO silo_app;
