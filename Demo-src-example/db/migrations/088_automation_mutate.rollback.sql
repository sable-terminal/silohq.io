DELETE FROM automation_actions WHERE kind = 'mutate';
ALTER TABLE automation_actions DROP CONSTRAINT IF EXISTS automation_actions_kind_check;
ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_kind_check CHECK (kind IN ('notify'));
DELETE FROM role_permissions WHERE permission_id = 'automation.mutate';
DELETE FROM permissions WHERE id = 'automation.mutate';
