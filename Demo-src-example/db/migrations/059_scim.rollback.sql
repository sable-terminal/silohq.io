ALTER TABLE memberships DROP COLUMN IF EXISTS provisioned_by_scim;
DROP FUNCTION IF EXISTS scim_token_owner(text);
DROP TABLE IF EXISTS scim_group_grants;
DROP TABLE IF EXISTS scim_group_members;
DROP TABLE IF EXISTS scim_groups;
DROP TABLE IF EXISTS scim_tokens;
