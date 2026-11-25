DELETE FROM role_permissions WHERE permission_id = 'terminology.manage';
DELETE FROM permissions WHERE id = 'terminology.manage';
DROP TABLE IF EXISTS presentation_lenses;
DROP TABLE IF EXISTS terminology;
