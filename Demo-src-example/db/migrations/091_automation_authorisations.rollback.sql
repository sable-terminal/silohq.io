DROP TRIGGER IF EXISTS automation_authorisations_immutable ON automation_authorisations;
DROP FUNCTION IF EXISTS automation_authorisations_immutable();
DROP TABLE IF EXISTS automation_authorisations;
DELETE FROM role_permissions WHERE permission_id = 'automation.execute';
DELETE FROM permissions WHERE id = 'automation.execute';
