DELETE FROM role_permissions WHERE permission_id = 'file.upload';
DELETE FROM permissions WHERE id = 'file.upload';
ALTER TABLE files
  DROP CONSTRAINT IF EXISTS files_export_is_received,
  DROP CONSTRAINT IF EXISTS files_export_has_no_outcome,
  DROP CONSTRAINT IF EXISTS files_upload_has_outcome;
DROP INDEX IF EXISTS files_awaiting_bytes;
ALTER TABLE files DROP COLUMN IF EXISTS received_at, DROP COLUMN IF EXISTS outcome;
