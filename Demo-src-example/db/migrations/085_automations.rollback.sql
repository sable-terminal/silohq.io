DELETE FROM role_permissions WHERE permission_id IN ('automation.create', 'automation.manage');
DELETE FROM permissions WHERE id IN ('automation.create', 'automation.manage');
DROP TABLE IF EXISTS automation_run_state;
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automation_actions;
DROP TABLE IF EXISTS automation_conditions;
DROP TABLE IF EXISTS automations;
