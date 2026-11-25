-- 007_identity_rls — a database-enforced floor under the identity plane.
--
-- FOUR TABLES HAD NO ROW LEVEL SECURITY AND IT WAS NEVER WRITTEN DOWN AS A
-- CHOICE. `users`, `sessions`, `password_resets` and `mfa_factors` are not
-- tenant-scoped — a person belongs to several organisations, so there is no
-- `organisation_id` to key a policy on, and that is a real reason. It is not a
-- reason to have no policy at all.
--
-- What protected them was that exactly one repository touched each and none of
-- them ever received a caller-supplied id. That was true when it was checked and
-- it is a property of the code, not of the database — which is the opposite of
-- how every other table in this schema is defended. The floor here is now the
-- same kind of thing it is everywhere else: something a future query cannot
-- quietly fall through.
--
-- ── The chicken and egg ─────────────────────────────────────────────────────
--
-- THREE LOOKUPS HAPPEN BEFORE ANYBODY KNOWS WHO IS ASKING, and each is the step
-- that establishes identity rather than a step that uses it:
--
--   users            by email      — signing in
--   sessions         by token hash — resolving a request's session
--   password_resets  by token hash — consuming a reset link
--
-- A policy keyed on `app_user_id()` cannot serve those: the whole purpose of the
-- query is to discover the value the policy would filter on. So each gets one
-- `SECURITY DEFINER` function, and those functions are the auditable holes —
-- the same shape as `invitation_by_token`, for the same reason.
--
-- EACH TAKES A SECRET AND RETURNS AT MOST ONE ROW. An email is not a secret, so
-- `user_by_email` is the weakest of the three; it is bounded instead by being
-- reachable only from the login path, which is rate limited and which burns a
-- constant-time password comparison whether or not a row came back.
--
-- `SET search_path` IS PINNED ON ALL OF THEM. A `SECURITY DEFINER` function that
-- resolves an unqualified name through a caller-controlled `search_path` runs
-- whatever the caller put there, as the owner. It is the classic way one of
-- these becomes a privilege escalation.

-- ── Lookups that establish identity ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION user_by_email(p_email text)
RETURNS SETOF users
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM users WHERE email = p_email::citext LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION session_by_token(p_token_hash text)
RETURNS SETOF sessions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM sessions WHERE token_hash = p_token_hash LIMIT 1;
$$;

/*
 * Consuming a reset token: the check and the mark, still one statement.
 *
 * NOT A READ FOLLOWED BY A WRITE, and that property is why this is a function
 * rather than a `SELECT` helper the service then updates through. Splitting them
 * opens a window in which the same token can be consumed twice — two concurrent
 * requests both read an unconsumed row, both proceed, and the second one sets a
 * password chosen by whoever replayed the link.
 *
 * A NULL RETURN MEANS WRONG, ALREADY USED, OR EXPIRED, indistinguishably. The
 * caller must not tell them apart to the person, because doing so says whether a
 * token ever existed.
 */
CREATE OR REPLACE FUNCTION consume_password_reset(p_token_hash text)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE password_resets SET consumed_at = now()
   WHERE token_hash = p_token_hash
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING user_id;
$$;

/*
 * Expiring sessions in bulk, for the sweeper.
 *
 * A CRON ACTS FOR NOBODY, so `app_user_id()` is null and the policy below
 * matches no rows — a delete that silently removes nothing and reports success,
 * which is how a sweeper stops working without anybody noticing. It gets a
 * function rather than an exemption, and the function can only delete rows that
 * have already expired.
 */
CREATE OR REPLACE FUNCTION delete_expired_sessions(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM sessions WHERE expires_at < p_before;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- ── Policies ────────────────────────────────────────────────────────────────

ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            FORCE  ROW LEVEL SECURITY;
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions         FORCE  ROW LEVEL SECURITY;
ALTER TABLE password_resets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets  FORCE  ROW LEVEL SECURITY;
ALTER TABLE mfa_factors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors      FORCE  ROW LEVEL SECURITY;

/*
 * `WITH CHECK` MATTERS AS MUCH AS `USING` HERE, AND MORE THAN USUAL.
 *
 * Without it, a caller could INSERT a session for another user — which is not a
 * data-integrity problem, it is minting a credential for somebody else's
 * account. `USING` alone would hide the row afterwards and the token would still
 * work, because the token is resolved through a `SECURITY DEFINER` function that
 * does not consult this policy.
 */
CREATE POLICY users_own ON users
  USING (id = app_user_id())
  WITH CHECK (id = app_user_id());

CREATE POLICY sessions_own ON sessions
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

CREATE POLICY password_resets_own ON password_resets
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

CREATE POLICY mfa_factors_own ON mfa_factors
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

/*
 * READING A COLLEAGUE'S NAME.
 *
 * The people list joins `users` through the tenant-scoped `memberships` table,
 * and `users_own` alone would reduce that join to one row: your own. This is the
 * same shape as `organisations_own` — you may see a user who shares an active
 * organisation with you, and only their row.
 *
 * `FOR SELECT`, because the reason to see a colleague is to render them. Without
 * the restriction it would also grant UPDATE, and a member could rewrite a
 * colleague's email address — which is an account takeover with extra steps.
 */
/*
 * KEYED ON THE ORGANISATION BEING ACTED IN, NOT ON THE READER'S OWN USER ID.
 *
 * The first version asked "do we share an organisation", by self-joining
 * `memberships` through `app_user_id()`. It was wrong twice. Practically: a
 * service that scopes itself with `runWithTenant({ organisationId,
 * membershipId })` sets no user id, so `app_user_id()` was null and the people
 * list came back empty — the policy silently denied everything rather than
 * failing. And in principle: visibility should follow the tenant somebody is
 * currently acting in, not the union of every organisation they belong to.
 * Sharing org B with a colleague is not a reason to see them while working in
 * org A.
 *
 * `app_org_id()` is set by every tenanted unit of work, which is exactly the
 * condition under which reading a colleague is meaningful.
 */
CREATE POLICY users_colleague ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships theirs
       WHERE theirs.user_id = users.id
         AND theirs.organisation_id = app_org_id()
         AND theirs.status <> 'removed'
    )
  );

GRANT EXECUTE ON FUNCTION user_by_email(text)             TO silo_app;
GRANT EXECUTE ON FUNCTION session_by_token(text)          TO silo_app;
GRANT EXECUTE ON FUNCTION consume_password_reset(text)    TO silo_app;
GRANT EXECUTE ON FUNCTION delete_expired_sessions(timestamptz) TO silo_app;
