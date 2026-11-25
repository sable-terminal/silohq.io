DELETE FROM automation_actions WHERE kind = 'report';
ALTER TABLE automation_actions DROP CONSTRAINT IF EXISTS automation_actions_kind_check;
ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_kind_check CHECK (kind IN ('notify', 'mutate', 'escalate'));
