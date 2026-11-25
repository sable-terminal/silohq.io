DROP INDEX IF EXISTS map_shares_one_per_organisation;
DROP INDEX IF EXISTS map_shares_one_per_scope;
DROP INDEX IF EXISTS map_shares_one_per_member;
ALTER TABLE map_shares
  ADD CONSTRAINT map_shares_unique_grantee
    UNIQUE (map_id, membership_id, scope_id, organisation_wide);
