ALTER TABLE siloes DROP CONSTRAINT siloes_retention_days_check;
ALTER TABLE siloes ADD CONSTRAINT siloes_retention_days_check
  CHECK (retention_days BETWEEN 1 AND 3650);

DELETE FROM role_permissions WHERE permission_id = 'approval.configure';
DELETE FROM permissions WHERE id = 'approval.configure';

DROP TRIGGER approval_decisions_second_person ON approval_decisions;
DROP FUNCTION approval_decided_by_second_person();

DROP TABLE approval_decisions;
DROP TABLE approval_requests;
DROP TABLE approval_policies;
