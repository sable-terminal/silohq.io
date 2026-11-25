DELETE FROM role_permissions WHERE permission_id = 'file.export';
DELETE FROM permissions WHERE id = 'file.export';
DROP TABLE IF EXISTS file_provenance;
DROP TABLE IF EXISTS file_permissions;
DROP TABLE IF EXISTS files;
