DROP FUNCTION IF EXISTS touch_api_key(uuid);
DROP FUNCTION IF EXISTS api_key_by_token(text);
DROP POLICY IF EXISTS role_assignments_principal ON role_assignments;
DROP INDEX IF EXISTS role_assignments_by_principal;
ALTER TABLE role_assignments
  DROP CONSTRAINT IF EXISTS role_assignments_one_subject,
  DROP COLUMN IF EXISTS principal_id;
-- Restored last: rows with a null membership must be gone first, and there are
-- none once the column above is dropped.
ALTER TABLE role_assignments ALTER COLUMN membership_id SET NOT NULL;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS service_principals;
