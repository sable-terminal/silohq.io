ALTER TABLE connections
  DROP COLUMN IF EXISTS credential_acts_as,
  DROP COLUMN IF EXISTS credential_rights;

ALTER TABLE connection_grants DROP CONSTRAINT IF EXISTS connection_grants_one_grantee;
ALTER TABLE connection_grants DROP COLUMN IF EXISTS organisation_wide;
ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_one_grantee CHECK (
    (membership_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int + (principal_id IS NOT NULL)::int = 1
  );
