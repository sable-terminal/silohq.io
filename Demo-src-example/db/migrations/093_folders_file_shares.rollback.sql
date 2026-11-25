DELETE FROM role_permissions WHERE permission_id IN ('file.share', 'file.manage');
DELETE FROM permissions WHERE id IN ('file.share', 'file.manage');
DROP TABLE IF EXISTS file_shares;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_folder_fkey;
UPDATE files SET folder_id = NULL;
DROP TABLE IF EXISTS folders;
