-- 047_sso_domain_check — the check that refused everybody.
--
-- ── What it does, and why it could never do it ─────────────────────────────
--
-- An SSO callback happens BEFORE there is a session, so there is no tenant
-- context: `runUntenanted('login-lookup')` says so explicitly and the rest of
-- the path is built for it. 010 gave that path the functions it needs —
-- `identity_provider_for_domain`, `identity_provider_by_id`,
-- `create_sso_attempt`, `consume_sso_attempt` — all SECURITY DEFINER, because a
-- pre-session lookup cannot satisfy a policy keyed on `app_org_id()`.
--
-- The domain allow-list check was written as a plain query against
-- `identity_provider_domains`, which has FORCE row level security and a policy
-- requiring `p.organisation_id = app_org_id()`. With no tenant set that function
-- returns NULL, `organisation_id = NULL` is NULL rather than true, and the
-- policy matches nothing. `silo_app` is not the table owner and does not bypass
-- RLS, so there is no escape.
--
-- So the check returned FALSE for every provider and every address, always, and
-- every SSO sign-in was refused with "that address is not one this directory is
-- allowed to sign in". Not a leak — the opposite. The one control on the path
-- was inert, and inert in the safe direction, which is why nothing raised it.
--
-- ── Why a function rather than tenant context ──────────────────────────────
--
-- There is no tenant to set. The organisation is what the lookup is FOR: it is
-- established by finding the provider, which is why 010 made that a function
-- too. Setting `app.org_id` from the provider before checking the provider's own
-- domains would be asserting the answer in order to check it.
--
-- ── What keeps it safe ─────────────────────────────────────────────────────
--
-- The provider id is the bound. The function answers only "is this domain
-- allow-listed for THIS provider", never "which provider owns this domain" —
-- so a caller holding a provider id learns one boolean about a provider it
-- already named, and nothing about anybody else's. The caller got that id from
-- `identity_provider_by_id`, which is itself bounded.

CREATE FUNCTION sso_domain_is_allowed(p_provider_id uuid, p_domain text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity_provider_domains
     WHERE provider_id = p_provider_id
       AND domain = p_domain::citext
  );
$$;

/*
 * 043's rule, applied at birth rather than retrofitted: a SECURITY DEFINER
 * function reaches past row level security, so PUBLIC must not hold it.
 */
REVOKE ALL ON FUNCTION sso_domain_is_allowed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sso_domain_is_allowed(uuid, text) TO silo_app;
