ALTER TABLE automation_actions DROP CONSTRAINT IF EXISTS automation_actions_kind_check;
DELETE FROM automation_actions WHERE kind = 'escalate';
ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_kind_check CHECK (kind IN ('notify', 'mutate'));
DROP TABLE IF EXISTS automation_escalations;
