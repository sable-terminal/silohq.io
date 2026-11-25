-- 028_sharing_model — shared by default, per-user by exception.
--
-- ── The organisation as a grantee ───────────────────────────────────────────
--
-- 016 offered three grantees: a person, a scope, a machine. The normal case for
-- an enterprise data platform is none of those — the organisation registers a
-- source once with a service account and EVERYONE uses it. Expressing that as a
-- grant on the root scope would work and would lie: it would look like a
-- decision about a subtree that happens to be the whole tree, and it would break
-- the moment somebody re-parented scopes.
--
-- ── What the credential acts as ─────────────────────────────────────────────
--
-- A reviewer's first question about a shared service credential is "what can it
-- reach". Today the only place that is answerable is inside the source system,
-- by somebody with admin there — which is the wrong place and usually the wrong
-- person. Recording it here does not enforce anything; it makes the blast radius
-- of a shared credential a fact Silo can show rather than one a customer has to
-- go and look up.
--
-- `unknown` IS THE DEFAULT AND IS MEANT TO BE VISIBLE. A connection whose rights
-- nobody recorded should read as a gap in the record, not as a quiet claim that
-- the credential is narrow.

ALTER TABLE connection_grants
  ADD COLUMN organisation_wide boolean NOT NULL DEFAULT false;

ALTER TABLE connection_grants
  DROP CONSTRAINT connection_grants_one_grantee;

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_one_grantee CHECK (
    (membership_id IS NOT NULL)::int
    + (scope_id IS NOT NULL)::int
    + (principal_id IS NOT NULL)::int
    + (organisation_wide)::int = 1
  );

ALTER TABLE connections
  /*
   * WHO THE CREDENTIAL IS AT THE SOURCE. `svc-silo@acme.com`, `silo_reader`, the
   * name of the Salesforce integration user. Free text because every system
   * spells a principal differently, and a lookup table of other people's
   * identity formats would be wrong within a month.
   */
  ADD COLUMN credential_acts_as text
    CHECK (credential_acts_as IS NULL OR length(trim(credential_acts_as)) BETWEEN 1 AND 256),

  /*
   * HOW MUCH THAT PRINCIPAL CAN REACH IN THE SOURCE. `broad` is an integration
   * user that can read everything and relies entirely on Silo to decide who sees
   * what. `scoped` is a credential the source has already limited. The
   * difference decides how much weight Silo's own field policies are carrying.
   */
  ADD COLUMN credential_rights text NOT NULL DEFAULT 'unknown'
    CHECK (credential_rights IN ('broad', 'scoped', 'unknown'));

COMMENT ON COLUMN connections.credential_rights IS
  'How much the credential can reach at the source. "broad" means Silo''s own '
  'field policies are the only limit and must be relied on; "unknown" means '
  'nobody recorded it, which is a gap rather than an assurance.';
