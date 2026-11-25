DELETE FROM role_permissions WHERE permission_id = 'field_policy.manage';
DELETE FROM permissions WHERE id = 'field_policy.manage';

DROP TABLE field_policies;
