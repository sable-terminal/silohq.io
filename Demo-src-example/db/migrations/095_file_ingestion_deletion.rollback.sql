DELETE FROM role_permissions WHERE permission_id = 'file.delete';
DELETE FROM permissions WHERE id = 'file.delete';
DROP TABLE IF EXISTS file_deletions;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_ingested_has_silo_file;
DROP INDEX IF EXISTS files_by_silo_file;
ALTER TABLE files DROP COLUMN IF EXISTS silo_file_id;
