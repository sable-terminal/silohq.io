-- 009_service_principals — identities that are not people.
--
-- A SCRIPT, A CRON, A CUSTOMER'S INTEGRATION. Everything until now has been a
-- human with a password, which means the only way to automate anything against
-- Silo was to create a fake person and share their credentials — an account with
-- no owner, no second factor, and no way to tell whose script it is when it
-- starts doing something odd.
--
-- ── One authority engine, not two ───────────────────────────────────────────
--
-- THE ASSIGNMENT TABLE LEARNS A SECOND KIND OF SUBJECT rather than principals
-- getting their own. A parallel `service_principal_roles` would have been a
-- smaller migration and a second implementation of "what may this subject do" —
-- and two permission engines drift. The one nobody looks at gains a bug, and the
-- bug is that a machine identity can do more than the model says.
--
-- So `role_assignments.membership_id` becomes nullable, gains `principal_id`
-- beside it, and a CHECK that exactly one is set. Every existing grant is
-- untouched and every existing query keeps working; `effectiveAssignments` grows
-- one branch instead of a twin.
--
-- ── What a principal is not ─────────────────────────────────────────────────
--
-- IT IS NOT A MEMBERSHIP AND DOES NOT CONSUME A SEAT. A seat is a licence for a
-- person; billing an organisation for its cron jobs would be a pricing decision
-- taken accidentally, in a migration, by whoever wired it. It also has no
-- scope membership: a principal's reach is exactly what has been granted to it
-- and nothing is implied by where it "sits", because it does not sit anywhere.

CREATE TABLE service_principals (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  description     text        CHECK (description IS NULL OR length(description) <= 500),

  /*
   * WHO IS ANSWERABLE FOR IT. The permission a principal holds was delegated by
   * a person, and when that person leaves somebody has to decide whether the
   * automation should still be running. A machine identity with no owner is the
   * one nobody turns off.
   */
  created_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  disabled_at     timestamptz,
  disabled_by     uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, name)
);

CREATE INDEX service_principals_by_org ON service_principals (organisation_id)
  WHERE disabled_at IS NULL;

/*
 * ── Keys ───────────────────────────────────────────────────────────────────
 *
 * ONLY THE HASH IS STORED, exactly as for sessions and invitations. A key that
 * can be read back out of the database is a key that a database backup, a log
 * line or a support screenshot leaks — and unlike a password there is nobody to
 * notice it being used.
 *
 * `prefix` AND `last_four` ARE FOR RECOGNITION, NOT FOR AUTHENTICATION. An
 * administrator looking at a list of keys has to be able to tell which one is in
 * which deployment, and "the one ending 8f2c" is how people actually do that.
 * Four characters of a 32-byte secret narrows nothing.
 */
CREATE TABLE api_keys (
  id            uuid        PRIMARY KEY,
  principal_id  uuid        NOT NULL REFERENCES service_principals(id) ON DELETE RESTRICT,

  name          text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  token_hash    text        NOT NULL UNIQUE,
  last_four     text        NOT NULL CHECK (length(last_four) = 4),

  created_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  /*
   * AN EXPIRY IS REQUIRED, AND THAT IS DELIBERATELY DIFFERENT FROM A ROLE GRANT.
   * A grant with no expiry is at least attached to a person somebody will
   * eventually offboard. A key with no expiry is a credential in a config file
   * that outlives the service, the repository and the employee who created it.
   */
  expires_at    timestamptz NOT NULL,

  revoked_at    timestamptz,
  revoked_by    uuid        REFERENCES memberships(id) ON DELETE RESTRICT,

  /*
   * Written on use, and the reason a key can be retired with confidence. "Is
   * anything still using this" is unanswerable without it, so nobody ever
   * revokes anything.
   */
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (principal_id, name)
);

CREATE INDEX api_keys_by_principal ON api_keys (principal_id) WHERE revoked_at IS NULL;

-- ── Assignments learn a second kind of subject ─────────────────────────────

ALTER TABLE role_assignments
  ALTER COLUMN membership_id DROP NOT NULL,
  ADD COLUMN principal_id uuid REFERENCES service_principals(id) ON DELETE RESTRICT,
  ADD CONSTRAINT role_assignments_one_subject CHECK (
    (membership_id IS NOT NULL AND principal_id IS NULL)
    OR (membership_id IS NULL AND principal_id IS NOT NULL)
  );

CREATE INDEX role_assignments_by_principal ON role_assignments (principal_id)
  WHERE principal_id IS NOT NULL AND revoked_at IS NULL;

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE service_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_principals FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys           FORCE  ROW LEVEL SECURITY;

CREATE POLICY service_principals_tenant ON service_principals
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

/*
 * `api_keys` REACHES THROUGH ITS PRINCIPAL rather than carrying its own
 * `organisation_id`. Denormalising would be faster and would create a second
 * answer to which tenant a key belongs to — and the two would disagree the first
 * time anything moved.
 */
CREATE POLICY api_keys_tenant ON api_keys
  USING (EXISTS (SELECT 1 FROM service_principals p
                  WHERE p.id = principal_id AND p.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM service_principals p
                       WHERE p.id = principal_id AND p.organisation_id = app_org_id()));

/*
 * The existing `role_assignments_tenant` policy reaches through `membership_id`,
 * which is now null for a principal's grants — so those rows match nothing and
 * are invisible. This is its sibling.
 */
CREATE POLICY role_assignments_principal ON role_assignments
  USING (EXISTS (SELECT 1 FROM service_principals p
                  WHERE p.id = principal_id AND p.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM service_principals p
                       WHERE p.id = principal_id AND p.organisation_id = app_org_id()));

/*
 * Authenticating a key happens before any tenant is known — the key is what
 * says which organisation is being acted in. Same shape as `session_by_token`.
 */
CREATE OR REPLACE FUNCTION api_key_by_token(p_token_hash text)
RETURNS TABLE (
  key_id uuid, principal_id uuid, organisation_id uuid,
  expires_at timestamptz, revoked_at timestamptz,
  principal_disabled_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.id, k.principal_id, p.organisation_id,
         k.expires_at, k.revoked_at, p.disabled_at
    FROM api_keys k
    JOIN service_principals p ON p.id = k.principal_id
   WHERE k.token_hash = p_token_hash
   LIMIT 1;
$$;

/*
 * Recording use. Separate from the lookup because the lookup is STABLE and this
 * writes — and because a failed authentication must not touch the row at all,
 * which would turn `last_used_at` into a record of guesses.
 */
CREATE OR REPLACE FUNCTION touch_api_key(p_key_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_keys SET last_used_at = now() WHERE id = p_key_id;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON service_principals, api_keys TO silo_app;
GRANT EXECUTE ON FUNCTION api_key_by_token(text) TO silo_app;
GRANT EXECUTE ON FUNCTION touch_api_key(uuid)    TO silo_app;
