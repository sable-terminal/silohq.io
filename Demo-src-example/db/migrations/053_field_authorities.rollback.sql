DELETE FROM role_permissions WHERE permission_id = 'authority.declare';
DELETE FROM permissions WHERE id = 'authority.declare';
DROP TABLE IF EXISTS field_authorities;
