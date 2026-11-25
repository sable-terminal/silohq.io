DROP TRIGGER IF EXISTS scopes_path_after ON scopes;
DROP TRIGGER IF EXISTS scopes_path_before ON scopes;
DROP FUNCTION IF EXISTS scopes_rewrite_descendants();
DROP FUNCTION IF EXISTS scopes_maintain_path();
DROP TABLE IF EXISTS scope_memberships;
DROP TABLE IF EXISTS scopes;
DROP TABLE IF EXISTS scope_types;
DROP FUNCTION IF EXISTS scope_label(uuid);
