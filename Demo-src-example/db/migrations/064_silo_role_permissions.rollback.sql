DELETE FROM role_permissions
 WHERE permission_id IN ('silo.create', 'silo.manage', 'silo.purge');

UPDATE permissions
   SET scopeable  = true,
       description = 'Create a Silo and choose what it stores'
 WHERE id = 'silo.enable';

/* Back to 004's grant, which included Admin. */
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'silo.enable'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
